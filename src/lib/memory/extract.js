/**
 * Memory Extraction — Parse memory suggestions from LLM response.
 * 
 * Approach: Parse memory suggestions from the LLM's own response.
 * Hermes-style: LLM is prompted to append memory suggestions to its response.
 * This avoids a second LLM call.
 * 
 * Detection: Look for MEMORY_SUGGEST: and USER_SUGGEST: markers in the response.
 */

import { loadMemoryFiles, saveMemoryFile, appendEntry } from "./store.js";
import { wouldBeDuplicate } from "./dedup.js";
import fs from "fs/promises";
import path from "path";
import os from "os";

/**
 * Parse memory suggestions from an LLM response.
 * Looks for multiple instances of:
 *   MEMORY_SUGGEST: <entry>
 *   USER_SUGGEST: <entry>
 *
 * @param {string} responseContent - the assistant's response text
 * @returns {{ memory: string[], user: string[] }}
 */
export function parseMemorySuggestions(responseContent) {
  if (!responseContent) return { memory: [], user: [] };

  const memoryMatches = [...responseContent.matchAll(/^MEMORY_SUGGEST:\s*(.+)$/gmi)];
  const userMatches = [...responseContent.matchAll(/^USER_SUGGEST:\s*(.+)$/gmi)];

  return {
    memory: memoryMatches.map(m => m[1].trim()),
    user: userMatches.map(m => m[1].trim()),
  };
}

/**
 * Extract and store memory from an LLM response.
 * Call this after getting the LLM response.
 * 
 * @param {string} responseContent - assistant's response text
 * @param {string} pool - memory pool name
 */
export const FALLBACK_THRESHOLD = 5; // after this many turns with no extraction, use stronger prompt

/**
 * Load extraction state for a pool (stats tracker).
 * @param {string} pool
 * @returns {Promise<{
 *   consecutiveMisses: number,
 *   totalRequests: number,
 *   totalAttempted: number,
 *   totalStored: number,
 *   totalSkipped: number,
 *   lastAttempt: string|null,
 *   lastStored: string|null
 * }>}
 */
export async function loadExtractionState(pool) {
  const statePath = path.join(os.homedir(), ".9router", "memory", pool, ".extraction-state.json");
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    return {
      consecutiveMisses: 0,
      totalRequests: 0,
      totalAttempted: 0,
      totalStored: 0,
      totalSkipped: 0,
      lastAttempt: null,
      lastStored: null,
      ...JSON.parse(raw),
    };
  } catch {
    return {
      consecutiveMisses: 0,
      totalRequests: 0,
      totalAttempted: 0,
      totalStored: 0,
      totalSkipped: 0,
      lastAttempt: null,
      lastStored: null,
    };
  }
}

/**
 * Record an extraction attempt outcome and save state.
 * Tracks cumulative lifetime stats plus consecutiveMisses for fallback logic.
 *
 * @param {string} pool
 * @param {{ wasStored: boolean, attempted: boolean, skippedCount?: number }} result
 */
export async function recordExtractionAttempt(pool, result) {
  // Normalize: legacy callers pass boolean directly
  if (typeof result === "boolean") {
    result = { wasStored: result, attempted: true, skippedCount: 0 };
  }
  const { wasStored, attempted, skippedCount = 0 } = result;

  const statePath = path.join(os.homedir(), ".9router", "memory", pool, ".extraction-state.json");
  const dir = path.dirname(statePath);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {}
  try {
    const raw = await fs.readFile(statePath, "utf-8").catch(() => "{}");
    const now = new Date().toISOString();
    const state = {
      consecutiveMisses: 0,
      totalRequests: 0,
      totalAttempted: 0,
      totalStored: 0,
      totalSkipped: 0,
      lastAttempt: null,
      lastStored: null,
      ...JSON.parse(raw),
    };

    state.totalRequests += 1;
    state.lastAttempt = now;

    if (attempted) {
      state.totalAttempted += 1;
    }

    if (wasStored) {
      state.consecutiveMisses = 0;
      state.totalStored += 1;
      state.lastStored = now;
    } else {
      state.consecutiveMisses = (state.consecutiveMisses || 0) + 1;
    }

    if (skippedCount > 0) {
      state.totalSkipped += skippedCount;
    }

    await fs.writeFile(statePath, JSON.stringify(state), "utf-8");
    console.log(`[MEMORY] STATE pool="${pool}" requests=${state.totalRequests} attempts=${state.totalAttempted} stored=${state.totalStored} skipped=${state.totalSkipped} misses=${state.consecutiveMisses} last=${now}`);
  } catch {
    // Ignore write errors
  }
}

/**
 * Check if a memory suggestion is worth storing.
 * Filters out trivial / too short / obviously bad entries.
 */
export function isWorthStoring(entry, type) {
  if (!entry) return false;
  const trimmed = entry.trim();
  if (trimmed.length < 10) return false;
  if (trimmed.startsWith("?")) return false;
  if (trimmed.startsWith("```")) return false;
  if (/^~\/[\w\-\/]+$/.test(trimmed)) return false;
  return true;
}

/**
 * @returns {Promise<{
 *   memoryStored: boolean,
 *   userStored: boolean,
 *   attempted: boolean,
 *   memorySkipped: number,
 *   userSkipped: number
 * }>}
 */
export async function extractAndStoreFromResponse(responseContent, pool) {
  const suggestions = parseMemorySuggestions(responseContent);

  // Check if LLM attempted extraction (markers present), regardless of whether we stored them
  const attempted = (suggestions.memory.length > 0 || suggestions.user.length > 0);

  if (!attempted) {
    const tail = responseContent.slice(-300).replace(/\n/g, "\\n").slice(0, 200);
    console.log(`[MEMORY] NO_MARKERS pool="${pool}" tail="${tail}"`);
    return { memoryStored: false, userStored: false, attempted: false, memorySkipped: 0, userSkipped: 0 };
  }

  console.log(`[MEMORY] MARKERS_FOUND pool="${pool}" memory=${suggestions.memory.length} user=${suggestions.user.length}`);

  const { memory: existingMemory, user: existingUser } = await loadMemoryFiles(pool);

  let memoryStored = false;
  let userStored = false;
  let memorySkipped = 0;
  let userSkipped = 0;

  // MEMORY suggestions
  let memoryContent = existingMemory;
  for (const entry of suggestions.memory) {
    if (!isWorthStoring(entry, "MEMORY")) {
      memorySkipped++;
    } else if (wouldBeDuplicate(memoryContent, entry)) {
      memorySkipped++;
    } else {
      const { content, wasTruncated } = appendEntry(memoryContent, entry, "MEMORY");
      memoryContent = content;
      await saveMemoryFile(pool, "MEMORY", content);
      if (!wasTruncated || content.length !== existingMemory.length) {
        memoryStored = true;
      }
      console.log(`[MEMORY] STORED pool="${pool}" type=MEMORY entry="${entry.slice(0, 100)}"${wasTruncated ? " truncated=true" : ""}`);
    }
  }

  // USER suggestions
  let userContent = existingUser;
  for (const entry of suggestions.user) {
    if (!isWorthStoring(entry, "USER")) {
      userSkipped++;
    } else if (wouldBeDuplicate(userContent, entry)) {
      userSkipped++;
    } else {
      const { content, wasTruncated } = appendEntry(userContent, entry, "USER");
      userContent = content;
      await saveMemoryFile(pool, "USER", content);
      if (!wasTruncated || content.length !== existingUser.length) {
        userStored = true;
      }
      console.log(`[MEMORY] STORED pool="${pool}" type=USER entry="${entry.slice(0, 100)}"${wasTruncated ? " truncated=true" : ""}`);
    }
  }

  if (memorySkipped > 0 || userSkipped > 0) {
    console.log(`[MEMORY] SKIPPED pool="${pool}" memory=${memorySkipped} user=${userSkipped}`);
  }

  return { memoryStored, userStored, attempted: true, memorySkipped, userSkipped };
}


/**
 * Build extraction hint text to append to the system prompt.
 * Tells the LLM to append MEMORY_SUGGEST / USER_SUGGEST markers.
 *
 * @param {boolean} isFallback - true if previous turns had no extraction
 * @returns {string}
 */
export function getExtractionHint(isFallback = false) {
  const base = `

---
## Memory Extraction

Persistent memory system. Remembers facts across sessions so future conversations start with useful context.

### What to store — state, not events

Store facts a future session would **measurably** benefit from knowing. These are *state* — architecture, tooling, preferences, decisions, established facts.

**Do NOT store *events*** — questions asked, commands run, topics discussed, routine interactions.

#### Good examples (state)
  MEMORY_SUGGEST: 9router uses chi router with middleware-chaining pattern, GORM for DB, MySQL
  MEMORY_SUGGEST: 9router PRs deploy via GitHub Actions, staging env at staging.9router.dev
  MEMORY_SUGGEST: core tests run via make test, use testify + httptest
  USER_SUGGEST: prefers bullet-point responses, no filler, no emojis
  USER_SUGGEST: hates when code examples omit error handling
  USER_SUGGEST: wants ≤2 sentence explanation before code blocks

#### Bad examples (events, vague, filler — DO NOT store)
  MEMORY_SUGGEST: User asked about routing today             # event, not state
  MEMORY_SUGGEST: User works on a Go project                 # vague — which project? what stack?
  MEMORY_SUGGEST: User said hi                                # routine, not memorable
  MEMORY_SUGGEST: User uses macOS                            # obvious from env context
  USER_SUGGEST: User likes clear answers                     # generic, no actionability
  USER_SUGGEST: User was polite today                         # event, not preference

### Specificity standard

Prefer concrete, precise details over labels. Ask: "Would I act differently in a future session knowing this?"

| Weak (don't store) | Strong (store) |
|---|---|
| "Go dev" | "9router: Go monolith, chi router, GORM, MySQL" |
| "uses testing" | "9router: tests with testify + httptest, make test" |
| "prefers short answers" | "USER: prefers ≤2 sentence explanation before code" |

When a fact applies to a **specific project**, prefix it: 9router:, core:, writings:. This prevents ambiguity.

### Value gate

Store only if: **"Would a future session make a measurably better decision or avoid a known mistake by knowing this?"**
- **YES** → store
- "Nice to have" → skip
- "Already obvious from env context" (e.g. macOS, zsh) → skip

### Quality over quantity

1 high-quality marker > 5 filler markers. It is **correct** to end a session with zero markers when nothing memorable was established. Zero markers is valid when:
- User says "thanks" or "ok"
- Simple confirmation or acknowledgment
- Routine chat with no new facts established

### Format

- Markers at **very end** of response, after all other content
- One line per marker, MEMORY_SUGGEST: or USER_SUGGEST: prefix
- No code fences, no markdown around markers, no extra formatting
- Project-prefix required for project-specific facts: 9router: <fact>
- Minimum 10 characters per marker content
- No ?, no code blocks, no bare file paths in marker content`;

  if (isFallback) {
    return base + `

The conversation established facts worth remembering. Use the store_memory tool if available, otherwise append MEMORY_SUGGEST: or USER_SUGGEST: markers at the end of your response. Call store_memory once per memorable fact.`;
  }

  return base;
}
