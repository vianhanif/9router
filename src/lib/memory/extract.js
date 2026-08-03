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
  // Concise hint: compresses ~65 lines of docs into 5 lines to preserve output token budget.
  // Still covers: state vs events, marker syntax, format rules, project-prefix convention.
  const base = `Persistent memory system — append MEMORY_SUGGEST: or USER_SUGGEST: markers at end of response (one line each, no code fences, no markdown). Store: state, not events (architecture, tooling, decisions, preferences). Min 10 chars. Project-prefix for project-specific: 9router: <fact>. Skip: trivial, obvious, or duplicate.`;

  if (isFallback) {
    return base + " Call store_memory tool if available.";
  }

  return base;
}
