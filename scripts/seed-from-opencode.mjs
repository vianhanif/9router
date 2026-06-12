#!/usr/bin/env node

/**
 * Seed 9router's SQLite usage database with historical OpenCode session data
 * so the usage dashboard shows full history.
 *
 * Usage:
 *   node scripts/seed-from-opencode.mjs
 *
 * Reads from: ~/.local/share/opencode/opencode.db (read-only)
 * Writes to:  ~/.9router/db/data.sqlite
 */

import Database from "better-sqlite3";
import path from "path";
import os from "os";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const OPENCODE_DB_PATH = path.join(os.homedir(), ".local/share/opencode/opencode.db");
const ROUTER_DB_PATH = path.join(os.homedir(), ".9router/db/data.sqlite");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse the model column. It can be either:
 *  - A JSON string: {"id":"big-pickle","providerID":"opencode"}
 *  - A plain string: "opencode/big-pickle"
 */
function parseModel(raw) {
  if (!raw) return { providerID: "unknown", id: "unknown" };
  if (typeof raw === "string" && raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      return {
        providerID: parsed.providerID || "unknown",
        id: parsed.id || raw,
      };
    } catch {
      return { providerID: "unknown", id: raw };
    }
  }
  return { providerID: "unknown", id: String(raw) };
}

/**
 * Format a Unix-ms timestamp into a local "YYYY-MM-DD" date key.
 */
function getLocalDateKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Counter helper — mirrors usageRepo.js addToCounter().
 */
function addToCounter(target, key, values) {
  if (!target[key]) target[key] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
  target[key].requests += values.requests || 1;
  target[key].promptTokens += values.promptTokens || 0;
  target[key].completionTokens += values.completionTokens || 0;
  target[key].cost += values.cost || 0;
  if (values.meta) Object.assign(target[key], values.meta);
}

// ---------------------------------------------------------------------------
// Step 1 — Read all sessions from OpenCode DB
// ---------------------------------------------------------------------------
console.log("Opening OpenCode DB:", OPENCODE_DB_PATH);
const src = new Database(OPENCODE_DB_PATH, { readonly: true });
const sessions = src.prepare("SELECT * FROM session").all();
src.close();

console.log(`Read ${sessions.length} sessions from OpenCode DB\n`);

// ---------------------------------------------------------------------------
// Step 2 — Filter & group by dateKey
// ---------------------------------------------------------------------------
const byDate = {};
let skipped9router = 0;
let skippedEmpty = 0;

for (const s of sessions) {
  const { providerID, id: modelId } = parseModel(s.model);

  // Skip sessions already tracked by 9router itself
  if (providerID === "9router") {
    skipped9router++;
    continue;
  }

  // Skip empty sessions (no tokens, no cost)
  if ((s.tokens_input === 0 || !s.tokens_input) && (s.cost === 0 || !s.cost)) {
    skippedEmpty++;
    continue;
  }

  const timestamp = new Date(s.time_created).toISOString();
  const dateKey = getLocalDateKey(s.time_created);

  const entry = {
    timestamp,
    provider: providerID,
    model: modelId,
    promptTokens: s.tokens_input || 0,
    completionTokens: s.tokens_output || 0,
    cost: s.cost || 0,
    tokens: {
      prompt_tokens: s.tokens_input || 0,
      completion_tokens: s.tokens_output || 0,
      reasoning_tokens: s.tokens_reasoning || 0,
      cache_read_input_tokens: s.tokens_cache_read || 0,
      cache_creation_input_tokens: s.tokens_cache_write || 0,
    },
    sourceSessionId: s.id,
  };

  if (!byDate[dateKey]) byDate[dateKey] = [];
  byDate[dateKey].push(entry);
}

console.log(`Skipped ${skipped9router} session(s) with providerID "9router"`);
console.log(`Skipped ${skippedEmpty} empty session(s) (0 tokens, 0 cost)`);
console.log(`Grouped remaining into ${Object.keys(byDate).length} dateKey(s)\n`);

// ---------------------------------------------------------------------------
// Step 3 — Open 9router DB & prepare statements
// ---------------------------------------------------------------------------
console.log("Opening 9router DB:", ROUTER_DB_PATH);
const target = new Database(ROUTER_DB_PATH);

// Enable WAL-friendly settings
target.pragma("journal_mode = WAL");
target.pragma("synchronous = NORMAL");

// Collect dateKeys that already exist
const existingDateKeys = new Set(
  target.prepare("SELECT dateKey FROM usageDaily").all().map((r) => r.dateKey)
);

// Collect already-seeded sourceSessionIds from meta column
const existingSessionIds = new Set();
const metaRows = target
  .prepare("SELECT meta FROM usageHistory WHERE meta IS NOT NULL AND meta != '{}'")
  .all();
for (const row of metaRows) {
  try {
    const m = JSON.parse(row.meta);
    if (m.sourceSessionId) existingSessionIds.add(m.sourceSessionId);
  } catch {
    // skip unparseable meta
  }
}
console.log(
  `Found ${existingDateKeys.size} existing dateKey(s) and ${existingSessionIds.size} already-seeded session ID(s) in target\n`
);

// Prepared statements
const insertHistory = target.prepare(`
  INSERT INTO usageHistory
    (timestamp, provider, model, connectionId, apiKey, endpoint,
     promptTokens, completionTokens, cost, status, tokens, meta)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getDaily = target.prepare("SELECT data FROM usageDaily WHERE dateKey = ?");

const upsertDaily = target.prepare(`
  INSERT INTO usageDaily (dateKey, data)
  VALUES (?, ?)
  ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data
`);

const getMeta = target.prepare(
  "SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'"
);

const setMeta = target.prepare(`
  INSERT INTO _meta (key, value)
  VALUES ('totalRequestsLifetime', ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

// ---------------------------------------------------------------------------
// Step 4 — Process each dateKey in a single transaction
// ---------------------------------------------------------------------------
const dateKeys = Object.keys(byDate).sort();
let totalSeeded = 0;
let totalSeededTokensInput = 0;
let totalSeededTokensOutput = 0;
let totalSeededCost = 0;

// Track which session IDs we've seen THIS run to avoid re-adding within a batch
const seenThisRun = new Set();

for (const dateKey of dateKeys) {
  if (existingDateKeys.has(dateKey)) {
    console.log(`  [SKIP] ${dateKey} — usageDaily row already exists`);
    continue;
  }

  const entries = byDate[dateKey];
  let dateSeeded = 0;
  let datePromptTokens = 0;
  let dateCompletionTokens = 0;
  let dateCost = 0;

  const tx = target.transaction(() => {
    // --- Insert usageHistory rows ---
    for (const entry of entries) {
      if (existingSessionIds.has(entry.sourceSessionId) || seenThisRun.has(entry.sourceSessionId)) {
        continue;
      }

      insertHistory.run(
        entry.timestamp,
        entry.provider,
        entry.model,
        null, // connectionId
        null, // apiKey
        null, // endpoint
        entry.promptTokens,
        entry.completionTokens,
        entry.cost,
        "ok",
        JSON.stringify(entry.tokens),
        JSON.stringify({ seeded: true, sourceSessionId: entry.sourceSessionId })
      );

      seenThisRun.add(entry.sourceSessionId);
      dateSeeded++;
      datePromptTokens += entry.promptTokens;
      dateCompletionTokens += entry.completionTokens;
      dateCost += entry.cost;
    }

    // If nothing was actually seeded, skip the daily aggregation too
    if (dateSeeded === 0) return;

    // --- Build usageDaily aggregation (mirrors aggregateEntryToDay) ---
    const day = {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
      byProvider: {},
      byModel: {},
      byAccount: {},
      byApiKey: {},
      byEndpoint: {},
    };

    for (const entry of entries) {
      // Skip already-seeded entries (same filter as above)
      if (existingSessionIds.has(entry.sourceSessionId) || !seenThisRun.has(entry.sourceSessionId)) {
        continue;
      }

      const promptTokens = entry.promptTokens;
      const completionTokens = entry.completionTokens;
      const cost = entry.cost;
      const vals = { promptTokens, completionTokens, cost };

      day.requests += 1;
      day.promptTokens += promptTokens;
      day.completionTokens += completionTokens;
      day.cost += cost;

      // byProvider
      if (entry.provider) {
        addToCounter(day.byProvider, entry.provider, vals);
      }

      // byModel — keyed by {model}|{provider}
      const modelKey = entry.provider
        ? `${entry.model}|${entry.provider}`
        : entry.model;
      addToCounter(day.byModel, modelKey, {
        ...vals,
        meta: { rawModel: entry.model, provider: entry.provider },
      });

      // byApiKey — no apiKey → local-no-key
      const akModelKey = `local-no-key|${entry.model}|${entry.provider || "unknown"}`;
      addToCounter(day.byApiKey, akModelKey, {
        ...vals,
        meta: { rawModel: entry.model, provider: entry.provider, apiKey: null },
      });

      // byEndpoint — no endpoint → Unknown
      const epKey = `Unknown|${entry.model}|${entry.provider || "unknown"}`;
      addToCounter(day.byEndpoint, epKey, {
        ...vals,
        meta: { endpoint: "Unknown", rawModel: entry.model, provider: entry.provider },
      });

      // byAccount — stays empty (no connectionId in seed data)
    }

    // Upsert the daily aggregation
    upsertDaily.run(dateKey, JSON.stringify(day));

    // Update totalRequestsLifetime
    const cur = getMeta.get();
    const curTotal = cur ? parseInt(cur.value, 10) : 0;
    setMeta.run(String(curTotal + day.requests));
  });

  tx();

  if (dateSeeded > 0) {
    console.log(
      `  [OK] ${dateKey} — ${dateSeeded} session(s), ${datePromptTokens} in / ${dateCompletionTokens} out, $${dateCost.toFixed(6)}`
    );
    totalSeeded += dateSeeded;
    totalSeededTokensInput += datePromptTokens;
    totalSeededTokensOutput += dateCompletionTokens;
    totalSeededCost += dateCost;
  } else {
    console.log(`  [SKIP] ${dateKey} — all ${entries.length} session(s) already seeded`);
  }
}

target.close();

// ---------------------------------------------------------------------------
// Step 5 — Summary
// ---------------------------------------------------------------------------
const dateRange =
  dateKeys.length >= 2
    ? `${dateKeys[0]} → ${dateKeys[dateKeys.length - 1]}`
    : dateKeys[0] || "(none)";

console.log("\n=== Seed Complete ===");
console.log(`  Sessions seeded:       ${totalSeeded}`);
console.log(`  Input tokens:          ${totalSeededTokensInput.toLocaleString()}`);
console.log(`  Output tokens:         ${totalSeededTokensOutput.toLocaleString()}`);
console.log(`  Total cost:            $${totalSeededCost.toFixed(6)}`);
console.log(`  Date range:            ${dateRange}`);
