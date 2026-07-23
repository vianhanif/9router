# 9router Memory System — Intuitive AI Agent Access

## Problem

Current memory system is write-once/read-everything:
- Entire MEMORY.md + USER.md dumped into every request (~3KB of flat `§`-separated entries)
- No query capability — agents receive memory passively, cannot search or update
- Flat file storage with lossy truncation (`slice(0, limit)`) when char limits hit
- No categorization, confidence, or staleness tracking
- No agent-initiated memory management beyond `store_memory` (no search/update/delete/list)

**Impact:** Agent gets a wall of facts it cannot filter, query, or maintain. Relevance degrades as entries accumulate.

## Current Architecture (as of 2026-07-22)

**Location:** `apps/server/src/lib/memory/` (monorepo: `9router/apps/server/`)
**Package:** `apps/server/package.json` (dependency added here, not root)
**Monorepo root:** `9router/package.json` (workspaces: `apps/*`, `packages/*`)

**Existing files with behavior:**

`pool.js` — `detectMemoryPool(apiKey)` maps API key prefix to pool (`warp`, `opencode`, etc.), fallback `default`

`store.js` — Flat file I/O only:
- `loadMemoryFiles(pool)` → reads `MEMORY.md` and `USER.md` from `~/.9router/memory/{pool}/`
- `saveMemoryFile(pool, type, content)` → writes flat file
- `appendEntry(currentContent, entry, type)` → appends entry with `§` separator, truncates at limit
- Char limits: MEMORY=2200, USER=1375
- Truncation: `slice(0, limit)` — oldest entries lost silently

`inject.js` — Formats and injects into request:
- `formatMemorySnippet(memoryContent, userContent)` → ASCII-art bordered block with usage stats
- `injectMemoryIntoMessages(messages, snippet)` → inserts `[PERSISTENT MEMORY]` system message after first system role

`extract.js` — Marker-based extraction from LLM response:
- `parseMemorySuggestions(responseContent)` — regex `matchAll` for `MEMORY_SUGGEST:`/`USER_SUGGEST:` lines (multi-match)
- `isWorthStoring(entry, type)` — minimum 10 chars, no `?` prefix, no code blocks, no bare paths
- `extractAndStoreFromResponse(responseContent, pool)` — parse → dedup-check → append → save
- `loadExtractionState(pool)` / `recordExtractionAttempt(pool, result)` — tracks stats in `.extraction-state.json` per pool
- `getExtractionHint(isFallback)` — returns LLM prompt instructing marker usage; fallback mode at 5+ consecutive misses
- `FALLBACK_THRESHOLD = 5`

`dedup.js` — Jaccard word similarity ≥0.6 → skip:
- `isNearDuplicate(existing, new)` — normalize → Jaccard on word sets
- `wouldBeDuplicate(existingContent, newEntry)` — iterates `§`-separated entries, checks each

`tool.js` — **Existing** `store_memory` tool for agent-mode conversations:
- `MEMORY_TOOL_DEFINITION` — OpenAI function-calling format
- `MEMORY_TOOL_ANTHROPIC` — Anthropic tool format
- `parseMemoryToolCalls(accumulatedToolCalls)` — extracts `{type, content}` from tool calls
- `storeFromToolCalls(entries, pool)` — dedup → append → save (bypasses `isWorthStoring`)

`index.js` — Public convenience API:
- `loadMemoryForRequest(apiKey, messages)` — load + inject (mutates messages in place)
- `tryExtractFromResponse(apiKey, responseContent)` — parse markers + store

**Integration in chat handler** (`apps/server/src/handlers/chat.js`):

**Request phase** (`handleSingleModelChat`, lines 158-208):
```
1. Check settings.memoryEnabled && body.messages exists
2. loadMemoryForRequest(apiKey, body.messages) — injects [PERSISTENT MEMORY] system msg
3. If userMsgCount > settings.memoryExtractionThreshold:
   a. Load extractionState, check FALLBACK_THRESHOLD
   b. getExtractionHint(isFallback) → append [MEMORY EXTRACTION HINT] system msg
   c. Guard: skip if hint already present (combo models share body)
4. If body.tools exists: inject store_memory tool
```

**Response phase** (`onStreamComplete` callback, lines 311-349):
```
1. Check settings.memoryEnabled
2. If contentObj.toolCalls exist: parseMemoryToolCalls → storeFromToolCalls (fire-and-forget)
   a. Don't double-process prose extraction if tool calls were handled
3. Else if contentObj.content exists: tryExtractFromResponse (marker-based, fire-and-forget)
```

**Key constraints:**
- Memory injection mutates `body.messages` directly (shared across combo/fusion models)
- Extraction is fire-and-forget (not in critical response path)
- Tool `store_memory` is only injected when `body.tools` already exists (agent mode)
- `onStreamComplete` receives `{content, toolCalls}` from `handleChatCore`

## Proposed Architecture

### Two-Tier Memory System

**Tier 1 (Always Injected — ~400 chars):** Curated summary of top-priority facts injected as `[PERSISTENT MEMORY]` system message (replaces current full-dump approach).

**Tier 2 (Tool Access):** 5 memory tools injected alongside existing `store_memory`: `memory_search`, `memory_update`, `memory_delete`, `memory_list`. Agent queries on demand. `store_memory` tool definition updated to accept `category` parameter.

### Storage: SQLite + Dual-Write Flat Files

Replace `MEMORY.md` / `USER.md` flat files with SQLite at `~/.9router/memory/{pool}/memory.db`.
Flat files continue as readable backup (dual-write). SQLite is source of truth for queries.

**Dependency:** `better-sqlite3` (sync API, no async overhead — correct for single-threaded Node proxy).
Fallback: `sql.js` (WASM, no native deps) if `better-sqlite3` build fails at install time.

```sql
-- Schema definition
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  pool TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL CHECK(type IN ('MEMORY', 'USER')),
  category TEXT CHECK(category IN ('preference','person','environment','project','decision','gotcha',NULL)),
  content TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0 CHECK(confidence >= 0 AND confidence <= 1),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_referenced TEXT,
  reference_count INTEGER NOT NULL DEFAULT 0,
  tags TEXT,
  is_confirmed INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0
);

-- Primary lookup: filter by pool, type, category, then by confidence (Tier 1 algorithm)
CREATE INDEX IF NOT EXISTS idx_memories_lookup ON memories(pool, is_archived, type, category, confidence DESC);

-- Staleness tracking: find entries needing decay
CREATE INDEX IF NOT EXISTS idx_memories_staleness ON memories(pool, is_archived, confidence, last_referenced);

-- Search: full-text for memory_search tool
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id, content, category);

-- Triggers to keep FTS in sync (FTS5 with explicit columns, no content=)
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories WHEN new.content IS NOT NULL BEGIN
  INSERT INTO memories_fts(id, content, category) VALUES (new.id, new.content, new.category);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories WHEN old.content IS NOT NULL BEGIN
  INSERT INTO memories_fts(memories_fts, id, content, category) VALUES ('delete', old.id, old.content, old.category);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories WHEN old.content IS NOT NULL OR new.content IS NOT NULL BEGIN
  INSERT INTO memories_fts(memories_fts, id, content, category) VALUES ('delete', old.id, old.content, old.category);
  INSERT INTO memories_fts(id, content, category) VALUES (new.id, new.content, new.category);
END;
```

**DB file path:** `~/.9router/memory/{pool}/memory.db`
**Connection:** Single `better-sqlite3` instance per pool, created lazily, held in module-level `Map<string, Database>`
**WAL mode:** Enabled for concurrent read safety (`PRAGMA journal_mode=WAL`)

### Categorization

Every entry stored gets classified. Auto-detect at write time, agent can override.

| Category | Description | Tier | Keyword Hints |
|----------|-------------|------|---------------|
| `preference` | How user wants output/interaction | Always Tier 1 | prefer, want, style, output, mode, like, dislike, tone |
| `person` | Name, role, communication style | Always Tier 1 | name, role, email, github, works at, engineer, developer |
| `environment` | OS, tools, paths, infra setup | Tier 1 if active | mac, linux, path, tool, cli, shell, terminal, installed |
| `project` | Tech stack, architecture, conventions | Tier 1 if active (2 days) | repo, project, stack, using, built with, framework, library |
| `decision` | Why something was done a certain way | Tier 2 (on-demand) | decided, chose, because, reason, instead of, opted |
| `gotcha` | Known bugs, workarounds, pitfalls | Tier 2 (on-demand) | bug, issue, workaround, broke, failed, crashed, careful |

**Auto-detection algorithm** (`categories.js -> autoDetectCategory(text, type)`):
```
1. If type === 'USER' AND (has person keywords OR has preference keywords) → match
2. Score each category by keyword hits / keyword set size
3. If maxScore > 0.3 → that category
4. If maxScore > 0.15 AND text.length < 100 → that category (short text, fewer keywords needed)
5. Else → NULL (uncategorized, still stored)
```

### Memory Tools

**6 tools total** (5 new + 1 existing `store_memory` updated):

**Tool 1: `store_memory`** (existing, extended with `category`):
```
name: store_memory
description: Store a fact about the user's environment, tools, or preferences for future sessions...
parameters:
  type: {type: string, enum: [MEMORY, USER]}
  content: {type: string, maxLength: 2200}
  category: {type: string, enum: [preference,person,environment,project,decision,gotcha], optional}
```

**Tool 2: `memory_search`**:
```
name: memory_search
description: Search stored memories. Use when you need to recall facts from past sessions.
parameters:
  query: {type: string, required, description: "Search terms"}
  type: {type: string, enum: [MEMORY, USER], optional}
  category: {type: string, enum: [preference,person,environment,project,decision,gotcha], optional}
  limit: {type: number, optional, default: 5, maximum: 20}
```

**Tool 3: `memory_update`**:
```
name: memory_update
description: Update an existing memory. Use when a stored fact is outdated or incorrect.
parameters:
  id: {type: string, required}
  content: {type: string, required, maxLength: 2200}
```

**Tool 4: `memory_delete`**:
```
name: memory_delete
description: Delete a memory entry. Use when a fact is no longer relevant.
parameters:
  id: {type: string, required}
```

**Tool 5: `memory_list`**:
```
name: memory_list
description: List stored memories. Use to see what the system remembers.
parameters:
  type: {type: string, enum: [MEMORY, USER], optional}
  category: {type: string, enum: [...], optional}
  limit: {type: number, optional, default: 20, maximum: 50}
```

**Tool 6: `memory_refresh`** (NEW — acknowledges a memory is still relevant):
```
name: memory_refresh
description: Bump confidence on a memory entry when you've used it. Prevents decay.
parameters:
  id: {type: string, required}
```

**Tool handler architecture** (`tools-extended.js`):
```
buildMemoryToolDefinitions() → returns array of 6 tool defs in OpenAI format
buildMemoryToolDefinitionsAnthropic() → returns array of 6 in Anthropic format
handleMemoryToolCall(pool, toolCall) → routes by name to handlers:
  store_memory → storeFromToolCalls (existing)
  memory_search → handleMemorySearch(pool, args)
  memory_update → handleMemoryUpdate(pool, args)
  memory_delete → handleMemoryDelete(pool, args)
  memory_list → handleMemoryList(pool, args)
  memory_refresh → handleMemoryRefresh(pool, args)
```

### Tool Execution Architecture — CRITICAL DESIGN DECISION

The existing `store_memory` tool works because storing is a *side effect* — the LLM doesn't need a return value. But `memory_search`, `memory_list`, and `memory_refresh` need to return results to the LLM so it can use them. This requires the proxy to intercept tool calls and return results locally, without forwarding to the LLM API.

#### Proxy-side Tool Execution Loop (new file: `toolExecutor.js`)

```
LLM response contains tool_use block for memory_search
  ↓
Proxy intercepts: detects it's a memory tool call
  ↓
Execute locally: searchMemories(pool, args) → results[]
  ↓
Append tool result message to conversation: {role: "tool", content: "Found 3 results: ..."}
  ↓
LLM sees tool result in messages, continues conversation
```

The user's client never sees the memory tool call/result exchange. The client only sees the final LLM response.

#### Why this works with the existing architecture:

The existing `onStreamComplete` hook in `chat.js` already processes tool calls from `contentObj.toolCalls` for `store_memory`. We extend this same hook to intercept all 6 memory tools, execute them locally, and append results to the conversation:

```javascript
// In onStreamComplete (chat.js lines 312-349):

// 1. Parse memory tool calls from the stream-complete event
const memoryToolCalls = parseMemoryToolCalls(contentObj.toolCalls);
if (memoryToolCalls.length === 0) {
  // Existing behavior: handle prose extraction (MEMORY_SUGGEST markers)
  return handleProseExtraction(contentObj.content);
}

// 2. Execute each memory tool locally (SQLite operations, no API call)
const toolResults = [];
for (const tc of memoryToolCalls) {
  const result = await handleMemoryToolCall(pool, tc);
  toolResults.push(result);
}

// 3. Build tool result messages in the correct format
const toolMessages = toolResults.map(r => {
  if (toolFormat === 'anthropic') {
    return { role: 'user', content: [{ type: 'tool_result', tool_use_id: r.id, content: r.content }] };
  }
  return { role: 'tool', tool_call_id: r.id, content: r.content };
});

// 4. Append to body.messages for LLM continuation
// The LLM sees the tool results as context and continues naturally
body.messages.push(...toolMessages);
```

Key differences from the previous approach (re-issue to LLM API):
- **No second API call needed** — the same streaming request already includes the tool results in the ongoing conversation
- **No `handleChatCore` re-invocation** — the continuation happens naturally as the LLM processes the tool result messages already in the conversation
- **Single round trip** — the LLM response includes tool calls, proxy executes them locally, LLM sees results and continues
- **Client transparency** — user's client never sees the memory tool call/result exchange, only the final response

#### Intercept vs Forward Decision

| Tool | Action | Reason |
|------|--------|--------|
| `memory_search` | Intercept | Must return results to LLM |
| `memory_list` | Intercept | Must return results to LLM |
| `memory_refresh` | Intercept | Returns confirmation to LLM |
| `memory_update` | Intercept | Returns confirmation to LLM |
| `memory_delete` | Intercept | Returns confirmation to LLM |
| `store_memory` | Intercept | Return confirmation (current: fire-and-forget) |

All 6 memory tools are intercepted and handled locally by the proxy. Non-memory tools pass through to the LLM API as before.

#### Tool Result Formatting (returned to LLM)

The proxy returns structured text results that the LLM can parse:

```
memory_search → "Found N results:
1. [id:xxx] content (confidence: 0.9, category: project)
2. ..."

memory_list → "Stored memories (N entries):
1. [id:xxx] [preference] content (conf: 1.0)
..."

memory_store → "Memory stored. ID: xxx"
memory_update → "Memory updated. ID: xxx"
memory_delete → "Memory deleted. ID: xxx"
memory_refresh → "Memory refreshed. ID: xxx, confidence: 1.0"
```

Each result includes the memory ID so the LLM can reference it in subsequent tool calls (e.g., `memory_refresh` after finding an entry via `memory_search`).

#### Tool Loop Safeguards

| Guard | Value | Reason |
|-------|-------|--------|
| Max memory tool iterations per request | 3 | Prevent infinite loops (agent keeps calling `memory_search`) |
| Tool result max length | 2000 chars | Prevent context bloat |

### Tier 1 Injection Algorithm

Replaces current `formatMemorySnippet()` which dumps everything.

```javascript
function buildTier1Summary(pool) {
  const db = getPoolDb(pool); // lazy, cached
  
  // Always: all USER entries (preferences are critical)
  const userEntries = db.prepare(`
    SELECT content FROM memories 
    WHERE pool = ? AND type = 'USER' AND is_archived = 0
    ORDER BY confidence DESC
  `).all(pool);
  
  const userText = userEntries.map(e => e.content).join('. ');
  
  // Category priority load
  const criticalMemories = db.prepare(`
    SELECT content, category, confidence FROM memories 
    WHERE pool = ? AND type = 'MEMORY' AND is_archived = 0
      AND (category IN ('preference', 'person')
           OR (confidence >= 0.8 AND last_referenced >= ?))
    ORDER BY confidence DESC, last_referenced DESC
  `).all(pool, sevenDaysAgo());
  
  // Budget: ~400 chars for Tier 1
  const BUDGET = 400;
  let used = userText.length;
  let summary = userText;
  
  for (const entry of criticalMemories) {
    if (used + entry.content.length + 2 > BUDGET) break;
    summary += '. ' + entry.content;
    used += entry.content.length + 2;
  }
  
  // If under budget, fill with high-confidence remaining
  if (used < BUDGET - 50) {
    const remaining = db.prepare(`
      SELECT content FROM memories
      WHERE pool = ? AND type = 'MEMORY' AND is_archived = 0
        AND id NOT IN (SELECT id FROM memories WHERE ...above filters...)
      ORDER BY confidence DESC, last_referenced DESC
      LIMIT 3
    `).all(pool);
    for (const entry of remaining) {
      if (used + entry.content.length + 2 > BUDGET) break;
      summary += '. ' + entry.content;
      used += entry.content.length + 2;
    }
  }
  
  return summary.slice(0, BUDGET);
}

function formatTier1Message(summary, pool) {
  if (!summary) return null;
  return `[PERSISTENT MEMORY — ACTIVE CONTEXT]

${summary}

Use memory_search, memory_list, memory_update, memory_delete, or memory_refresh to manage stored facts.`;
}
```

### Confidence Decay

Runs on every `loadMemoryForRequest()` call (lightweight SQL).

```javascript
function applyDecay(pool) {
  const db = getPoolDb(pool);
  // Only touch entries with last_referenced older than 1 day
  const stmt = db.prepare(`
    UPDATE memories SET 
      confidence = MAX(0, confidence * POWER(0.95, 
        CAST((julianday('now') - julianday(COALESCE(last_referenced, created_at))) AS INTEGER)
      )),
      updated_at = datetime('now')
    WHERE pool = ? 
      AND is_archived = 0
      AND confidence > 0
      AND COALESCE(last_referenced, created_at) < datetime('now', '-1 day')
  `);
  stmt.run(pool);
  
  // Archive entries with confidence below 0.3
  const archiveStmt = db.prepare(`
    UPDATE memories SET is_archived = 1, updated_at = datetime('now')
    WHERE pool = ? AND is_archived = 0 AND confidence < 0.3
  `);
  archiveStmt.run(pool);
}
```

**Decay schedule:** Decay on every loadMemoryForRequest (per chat turn). For a pool with ~15 entries, this is ~2ms of SQL work.

### Consolidation

Triggered when active (non-archived) memory entries exceed threshold.

```javascript
const CONSOLIDATION_THRESHOLD = 20;

function shouldConsolidate(pool) {
  const db = getPoolDb(pool);
  const { count } = db.prepare(`
    SELECT COUNT(*) as count FROM memories WHERE pool = ? AND is_archived = 0
  `).get(pool);
  return count > CONSOLIDATION_THRESHOLD;
}

async function runConsolidation(pool) {
  const db = getPoolDb(pool);
  const entries = db.prepare(`
    SELECT id, type, category, content, confidence, created_at 
    FROM memories WHERE pool = ? AND is_archived = 0
    ORDER BY confidence DESC
  `).all(pool);
  
  // Build prompt for LLM consolidation
  const prompt = buildConsolidationPrompt(entries);
  
  // Send to fast/cheap model (e.g., gpt-4.1-nano or haiku)
  const consolidated = await callLLMForConsolidation(prompt);
  
  // In transaction: archive old entries, insert consolidated set
  const txn = db.transaction(() => {
    db.prepare(`UPDATE memories SET is_archived = 1 WHERE pool = ?`).run(pool);
    for (const entry of consolidated) {
      db.prepare(`INSERT INTO memories (pool, type, category, content, confidence, is_confirmed) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(pool, entry.type, entry.category, entry.content, 0.9, entry.is_confirmed);
    }
  });
  txn();
}
```

**Consolidation prompt:**
```
You are merging memory entries. Combine related facts, remove duplicates, discard outdated info.

Rules:
- Merge entries about the same topic into one
- Remove entries contradicted by newer ones
- Preserve all USER preferences exactly
- Keep specific technical details (paths, versions, config)
- Target: ≤15 entries

Entries:
[ID:TYPE:CATEGORY] content (confidence=N)
...

Output: one entry per line in format: TYPE|CATEGORY|content
```

**Trigger location:** In `loadMemoryForRequest()`, after injection but only if `shouldConsolidate()` and last consolidation was >1 hour ago. Fire-and-forget (not on critical path).

### search_tool Implementation Detail

Search uses SQLite FTS5 for word-level matching, with a LIKE fallback:

```javascript
function searchMemories(db, { query, type, category, limit = 5 }) {
  // FTS5 search for relevance-ranked results
  let sql = `
    SELECT m.id, m.type, m.category, m.content, m.confidence, m.created_at,
           snippet(memories_fts, 0, '', '', '...', 32) as highlight
    FROM memories m
    JOIN memories_fts fts ON m.rowid = fts.rowid
    WHERE memories_fts MATCH ? AND m.pool = ? AND m.is_archived = 0
  `;
  const params = [escapeFtsQuery(query), pool];
  
  if (type) { sql += ' AND m.type = ?'; params.push(type); }
  if (category) { sql += ' AND m.category = ?'; params.push(category); }
  
  sql += ' ORDER BY rank LIMIT ?';
  params.push(limit);
  
  let results = db.prepare(sql).all(...params);
  
  // FTS5 fallback: if no results, try LIKE on content
  if (results.length === 0) {
    sql = `SELECT id, type, category, content, confidence, created_at
           FROM memories WHERE pool = ? AND is_archived = 0 AND content LIKE ?`;
    params = [pool, `%${query}%`];
    if (type) { sql += ' AND type = ?'; params.push(type); }
    if (category) { sql += ' AND category = ?'; params.push(category); }
    sql += ' ORDER BY confidence DESC LIMIT ?';
    params.push(limit);
    results = db.prepare(sql).all(...params);
  }
  
  // Bump reference count + last_referenced on each returned result
  for (const r of results) {
    db.prepare(`UPDATE memories SET reference_count = reference_count + 1, last_referenced = datetime('now') WHERE id = ?`).run(r.id);
  }
  
  return results;
}
```

## Implementation Plan

### Phase 1: SQLite Storage Layer

**Package:** `apps/server/package.json`

**Files to create:**
- `apps/server/src/lib/memory/schema.js` — schema DDL, migration helpers, `getPoolDb()`

**Files to modify:**
- `apps/server/src/lib/memory/store.js` — rewrite with SQLite + dual-write to flat files

**`schema.js` interface:**
```
initPoolDb(pool) → creates/opens memory.db for pool, runs schema DDL, returns db handle
  - Path: ~/.9router/memory/{pool}/memory.db
  - PRAGMA journal_mode=WAL, foreign_keys=ON
  - Module-level Map<string, Database> cache (keyed by pool)
  
getPoolDb(pool) → returns cached or newly initialized db handle
closePoolDb(pool) → closes connection, removes from cache
closeAllDbs() → closes all (graceful shutdown)
```

**`store.js` changes — backward compatible exports:**
```
loadMemoryFiles(pool) → 
  - Loads from SQLite (source of truth)
  - Falls back to flat files if SQLite empty (migration not yet run)
  - Returns {memory, user} strings (same format as current — backwards compat)
  - Format: §-separated entries for backwards compat (internally builds from SQL rows)

saveMemoryFile(pool, type, content) →
  - If content is §-separated bulk (from appendEntry path): parse into entries, INSERT each
  - Also writes flat file for backup

appendEntry(flatContent, entry, type) →
  - Kept for backwards compat but marked deprecated
  - Formats as before, returns {content, wasTruncated}
  - Internally calls new insertEntry() for SQLite

NEW: insertEntry(pool, type, content, {category, confidence, isConfirmed}) →
  - INSERT INTO memories with all metadata
  - Returns inserted row id

NEW: getEntries(pool, filters) → query with WHERE clauses
NEW: getEntryById(pool, id) → single row
NEW: updateEntry(pool, id, content) → UPDATE
NEW: deleteEntry(pool, id) → DELETE (hard, from FK perspective)
NEW: refreshEntry(pool, id) → UPDATE confidence = MIN(1, confidence + 0.05), last_referenced
NEW: countActiveEntries(pool) → SELECT COUNT(*) WHERE is_archived = 0
```

**Dual-write strategy:**
```
Every INSERT/UPDATE/DELETE → writes SQLite FIRST, then async writes flat files
  - SQLite write: synchronous (data integrity)
  - Flat file write: fs.writeFile (non-blocking, fire-and-forget with error logging)
  - If flat file write fails: no impact on SQLite state, logged as warning
  
Flat file format maintained:
  # Memory
  §
  entry1 content
  §
  entry2 content
```

**SQLite module dependency resolution:**
```
// Try better-sqlite3 first (native, fast)
try {
  const Database = require('better-sqlite3');
} catch {
  // Fallback to sql.js (WASM, slower but no native deps)
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  // Wrapper class replicating better-sqlite3 sync API surface
}
```

### Phase 2: Extended Memory Tools + Injection

**Files to create:**
- `apps/server/src/lib/memory/tools-extended.js` — new 5 tool defs + handlers

**Files to modify:**
- `apps/server/src/lib/memory/tool.js` — extend `store_memory` def with `category`, export existing handlers
- `apps/server/src/lib/memory/inject.js` — rewrite `formatMemorySnippet()` → Tier 1 algorithm
- `apps/server/src/lib/memory/index.js` — add `buildMemoryTools()`, `handleMemoryToolResult()` exports
- `apps/server/src/handlers/chat.js` — update injection logic

**Current tool injection (chat.js lines 194-205):**
```javascript
// Inject store_memory tool if request has tools (agent-mode conversations)
if (body.tools && body.tools.length > 0) {
  const hasStoreMemory = body.tools.some(t =>
    t.function?.name === MEMORY_TOOL_NAME || t.name === MEMORY_TOOL_NAME
  );
  if (!hasStoreMemory) {
    body.tools.push({ type: "function", function: MEMORY_TOOL_DEFINITION });
  }
}
```

**New injection logic:**
```javascript
// Inject all memory tools when settings.memoryEnabled && memory data exists
if (settings.memoryEnabled && body.messages) {
  const pool = detectMemoryPool(apiKey);
  const db = getPoolDb(pool);
  const { count } = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE pool = ? AND is_archived = 0`).get(pool);
  
  if (count > 0 && body.tools) {
    // Agent mode with existing tools: inject all memory tools
    const allMemoryTools = buildMemoryToolDefinitions(); // 6 tools
    for (const memTool of allMemoryTools) {
      const exists = body.tools.some(t =>
        (t.function?.name || t.name) === memTool.name
      );
      if (!exists) {
        body.tools.push({ type: "function", function: memTool });
      }
    }
  }
}
```

### Phase 3: Categorization + Extraction Integration

**Files to create:**
- `apps/server/src/lib/memory/categories.js` — keyword maps + autoDetectCategory()

**Files to modify:**
- `apps/server/src/lib/memory/extract.js` — enrich with category, use new SQLite store
- `apps/server/src/lib/memory/tool.js` — enrich `storeFromToolCalls()` with category
- `apps/server/src/lib/memory/tools-extended.js` — `memory_store` handler uses category auto-detect
- `apps/server/src/lib/memory/dedup.js` — unmodified (Jaccard still valid for SQL entries)

**`extract.js` changes:**
```
parseMemorySuggestions() — unchanged (regex extraction)
isWorthStoring() — unchanged (quality filter)

extractAndStoreFromResponse(responseContent, pool) — rewritten:
  1. Parse suggestions as before
  2. For each worth-storing suggestion:
     a. autoDetectCategory(suggestion, type)
     b. Check dedup against SQL entries (NOT flat file content)
        → wouldBeDuplicate now queries SQLite: 
           SELECT content FROM memories WHERE pool = ? AND type = ? AND is_archived = 0
           Then Jaccard against each entry
     c. If not duplicate: insertEntry(pool, type, content, {category})
  3. Also writes flat file (dual-write)
  4. Return {memoryStored, userStored, attempted, memorySkipped, userSkipped}
```

### Phase 4: Confidence Decay + Consolidation

**Files to create:**
- `apps/server/src/lib/memory/decay.js` — decay logic + consolidation trigger
- `apps/server/src/lib/memory/consolidate.js` — consolidation prompt + LLM call

**Files to modify:**
- `apps/server/src/lib/memory/index.js` — add `applyDecayAndConsolidate()` to `loadMemoryForRequest()`

**Integration in `loadMemoryForRequest()`:**
```javascript
export async function loadMemoryForRequest(apiKey, messages) {
  const pool = detectMemoryPool(apiKey);
  
  // Step 1: Apply confidence decay (synchronous, ~2ms)
  applyDecay(pool);
  
  // Step 2: Build Tier 1 summary from SQLite
  const summary = buildTier1Summary(pool);
  
  // Step 3: Inject as system message
  if (summary) {
    const tier1Message = formatTier1Message(summary, pool);
    injectMemoryIntoMessages(messages, tier1Message);
  }
  
  // Step 4: Check consolidation (fire-and-forget, non-blocking)
  if (shouldConsolidate(pool)) {
    runConsolidation(pool).catch(err => 
      console.warn(`[MEMORY] CONSOLIDATION_ERROR pool="${pool}" ${err.message}`)
    );
  }
  
  return { injected: !!summary, pool };
}
```

**Consolidation LLM call details:**
- Model: uses first available provider from settings (cheapest model available)
- No streaming needed (single JSON/text response)
- Timeout: 30 seconds
- Max entries per consolidation batch: 50
- Cooldown: minimum 1 hour between consolidations per pool

### Phase 5: Migration + Cleanup

**Files to create:**
- `apps/server/src/lib/memory/migrate.js` — one-time migration runner

**Migration logic:**
```javascript
export async function migratePoolToSqlite(pool) {
  const db = getPoolDb(pool);
  
  // Step 1: Read existing flat files
  const { memory, user } = await loadMemoryFilesFromDisk(pool);
  
  // Step 2: Parse §-separated entries
  const memoryEntries = parseFlatEntries(memory); // split on '§', trim blanks
  const userEntries = parseFlatEntries(user);
  
  // Step 3: Count existing SQLite entries (idempotency check)
  const { existingCount } = db.prepare(`SELECT COUNT(*) as existingCount FROM memories WHERE pool = ?`).get(pool);
  if (existingCount > 0) {
    console.log(`[MEMORY] MIGRATE pool="${pool}" already has ${existingCount} entries — skipping`);
    return { pool, migrated: false, count: existingCount };
  }
  
  // Step 4: Insert into SQLite with default metadata
  const insert = db.prepare(`INSERT INTO memories (pool, type, category, content, confidence, is_confirmed) VALUES (?, ?, ?, ?, ?, ?)`);
  
  const txn = db.transaction(() => {
    for (const entry of memoryEntries) {
      const category = autoDetectCategory(entry, 'MEMORY');
      insert.run(pool, 'MEMORY', category, entry, 1.0, 1); // confirmed=true for existing
    }
    for (const entry of userEntries) {
      const category = autoDetectCategory(entry, 'USER');
      insert.run(pool, 'USER', category, entry, 1.0, 1);
    }
  });
  txn();
  
  // Step 5: Verify
  const { newCount } = db.prepare(`SELECT COUNT(*) as newCount FROM memories WHERE pool = ?`).get(pool);
  const expected = memoryEntries.length + userEntries.length;
  
  if (newCount !== expected) {
    console.warn(`[MEMORY] MIGRATE pool="${pool}" count mismatch expected=${expected} actual=${newCount}`);
  }
  
  console.log(`[MEMORY] MIGRATE pool="${pool}" entries=${newCount} source="flat files"`);
  return { pool, migrated: true, count: newCount };
}

export async function migrateAllPools() {
  const pools = listKnownPools(); // from pool.js
  const results = [];
  for (const pool of pools) {
    results.push(await migratePoolToSqlite(pool));
  }
  return results;
}
```

**Migration trigger:** Called on server startup (`apps/server` entry point) once. Idempotent.

**Rollback support:** Before migration, flat files are backed up as `MEMORY.md.bak-{date}` and `USER.md.bak-{date}`.

## File Changes Summary

All paths relative to `apps/server/src/lib/memory/` unless noted.

| File | Action | Phase |
|------|--------|-------|
| `schema.js` | Create | P1 |
| `store.js` | Rewrite (SQLite + dual-write, backwards compatible) | P1 |
| `toolExecutor.js` | Create (tool execution loop + intercept logic) | P2 |
| `tools-extended.js` | Create (5 new tool defs + handlers) | P2 |
| `tool.js` | Modify (extend `store_memory` with `category`) | P2 |
| `inject.js` | Rewrite `formatMemorySnippet()` → Tier 1 | P2 |
| `index.js` | Modify (add tool exports, decay, consolidation) | P2 |
| `categories.js` | Create | P3 |
| `extract.js` | Modify (auto-categorize, SQLite dedup check) | P3 |
| `decay.js` | Create | P4 |
| `consolidate.js` | Create | P4 |
| `migrate.js` | Create | P5 |
| `dedup.js` | Unchanged (still used, now queries SQL rows) | — |
| `pool.js` | Unchanged | — |
| `../handlers/chat.js` | Modify (updated tool injection + response handling) | P2 |
| `apps/server/package.json` | Add `better-sqlite3` dependency | P1 |

## Testing Strategy

### Unit Tests (`apps/server/tests/unit/memory/`)

**New test files:**
- `store-sqlite.test.js` — SQLite CRUD, migration, dual-write, connection pooling
- `search.test.js` — FTS5 search, LIKE fallback, empty results
- `tier1-injection.test.js` — budget enforcement, category priority, overflow behavior
- `categorization.test.js` — autoDetectCategory for each category, edge cases
- `decay.test.js` — decay calculation, archive threshold, no-op for recent entries
- `consolidation.test.js` — threshold check, prompt building, transaction rollback
- `tools-handlers.test.js` — all 6 tool handlers, error cases, reference counting
- `migrate.test.js` — flat file to SQLite, idempotency, count verification

**Existing tests to update:**
- `memory.test.js` — update assertions for new `loadMemoryFiles()` return format

### Integration Tests

1. **Migration smoke test:** Create fake `MEMORY.md` with 5 `§` entries → run `migratePoolToSqlite('test-pool')` → verify 5 rows in SQLite
2. **Injection test:** Send chat request → verify `[PERSISTENT MEMORY — ACTIVE CONTEXT]` in messages
3. **Tool test:** Simulate `memory_search` tool call → verify FTS5 results + reference_count bump
4. **Decay test:** Set `created_at` to 30 days ago → call `applyDecay()` → verify confidence reduced
5. **End-to-end proxy test:** Start proxy → curl chat endpoint → verify response has markers → verify SQLite stored

## Risks + Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `better-sqlite3` native build failure | Medium | High (blocker) | Auto-fallback to `sql.js` (WASM). Detect at import, log warning |
| Migration corrupts existing memories | Low | High | Backup flat files as `.bak-{date}` before migration. Validate row count |
| Tool injection increases token usage | Medium | Medium | Only inject when memory > 0 entries. Tools add ~800 chars (~200 tokens) |
| FTS5 trigger overhead on every INSERT | Low | Low | SQLite FTS triggers are incremental. 1ms per insert on small tables |
| Consolidation LLM call hangs | Low | Medium | 30s timeout, catch + log, retry next cycle. Non-blocking |
| Dual-write flat file lag | Low | Low | Flat file writes are fire-and-forget. SQLite is always source of truth |
| Combo model body sharing | Medium | Low | Existing guard (`alreadyHasHint` check). Memory tools injected once per body |

## Rollout Plan

1. **Week 1:** Phase 1 (SQLite storage) — deploy behind `memorySqliteEnabled` feature flag
2. **Week 2:** Phase 2-3 (tools + categorization) — enabled by default when SQLite mode active
3. **Week 3:** Phase 4 (decay + consolidation) — observe decay patterns before enabling consolidation
4. **Week 4:** Phase 5 (migration) — auto-migrate on startup, deprecate flat file reads
5. **Week 6:** Remove feature flag, delete flat file read path, keep dual-write for 1 more release

## Future Considerations (not in this plan)

- Embedding-based semantic search (ONNX runtime for local embeddings, no API cost)
- Cross-pool memory federation (share certain entries between `warp` and `opencode` pools)
- Memory analytics dashboard (pool stats, category distribution, extraction rate)
- User-facing memory management UI (review/edit/delete entries from dashboard)
- Memory import/export for sharing between machines
