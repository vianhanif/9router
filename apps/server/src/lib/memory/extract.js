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
 * Load extraction state for a pool (turn counter).
 * @param {string} pool
 * @returns {Promise<{consecutiveMisses: number}>}
 */
export async function loadExtractionState(pool) {
  const statePath = path.join(os.homedir(), ".9router", "memory", pool, ".extraction-state.json");
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { consecutiveMisses: 0 };
  }
}

/**
 * Record an extraction attempt outcome and save state.
 * Increments consecutiveMisses if nothing stored, resets on success.
 * @param {string} pool
 * @param {boolean} wasStored - true if any memory was stored
 */
export async function recordExtractionAttempt(pool, wasStored) {
  const statePath = path.join(os.homedir(), ".9router", "memory", pool, ".extraction-state.json");
  const dir = path.dirname(statePath);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {}
  try {
    const raw = await fs.readFile(statePath, "utf-8").catch(() => "{\"consecutiveMisses\":0}");
    const state = JSON.parse(raw);
    const prevMisses = state.consecutiveMisses || 0;
    state.consecutiveMisses = wasStored ? 0 : prevMisses + 1;
    await fs.writeFile(statePath, JSON.stringify(state), "utf-8");
    console.log(`[MEMORY] EXTRACTION_STATE pool="${pool}" wasStored=${wasStored} misses=${prevMisses}->${state.consecutiveMisses} ${wasStored ? "RESET" : "INCREMENT"}`);
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
 * @returns {Promise<{memoryStored: boolean, userStored: boolean, attempted: boolean}>}
 */
export async function extractAndStoreFromResponse(responseContent, pool) {
  const suggestions = parseMemorySuggestions(responseContent);
  
  // Check if LLM attempted extraction (markers present), regardless of whether we stored them
  const attempted = (suggestions.memory.length > 0 || suggestions.user.length > 0);
  
  if (!attempted) {
    return { memoryStored: false, userStored: false, attempted: false };
  }

  console.log(`[MEMORY] MARKERS_FOUND pool="${pool}" memory=${suggestions.memory.length} user=${suggestions.user.length}`);

  const { memory: existingMemory, user: existingUser } = await loadMemoryFiles(pool);
  
  let memoryStored = false;
  let userStored = false;
  let memorySkipped = [];
  let userSkipped = [];

  // MEMORY suggestions
  for (const entry of suggestions.memory) {
    if (!isWorthStoring(entry, "MEMORY")) {
      memorySkipped.push("not-worth-storing");
    } else if (wouldBeDuplicate(existingMemory, entry)) {
      memorySkipped.push("duplicate");
    } else {
      const { content, wasTruncated } = appendEntry(existingMemory, entry, "MEMORY");
      await saveMemoryFile(pool, "MEMORY", content);
      memoryStored = true;
      console.log(`[MEMORY] STORED pool="${pool}" type=MEMORY entry="${entry.slice(0, 100)}"${wasTruncated ? " truncated=true" : ""}`);
    }
  }

  // USER suggestions
  for (const entry of suggestions.user) {
    if (!isWorthStoring(entry, "USER")) {
      userSkipped.push("not-worth-storing");
    } else if (wouldBeDuplicate(existingUser, entry)) {
      userSkipped.push("duplicate");
    } else {
      const { content, wasTruncated } = appendEntry(existingUser, entry, "USER");
      await saveMemoryFile(pool, "USER", content);
      userStored = true;
      console.log(`[MEMORY] STORED pool="${pool}" type=USER entry="${entry.slice(0, 100)}"${wasTruncated ? " truncated=true" : ""}`);
    }
  }

  if (memorySkipped.length > 0 || userSkipped.length > 0) {
    console.log(`[MEMORY] SKIPPED pool="${pool}" memory=${memorySkipped.join(",")} user=${userSkipped.join(",")}`);
  }

  return { memoryStored, userStored, attempted: true };
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
## MEMORY EXTRACTION — YOU MUST FOLLOW THIS

This is a persistent memory system. It lets you remember facts across sessions.

**You MUST append markers when memorable facts are established:**
- MEMORY_SUGGEST: <fact about user's environment, project, tooling, decisions>
- USER_SUGGEST: <fact about user's preferences, communication style>

Examples:
  MEMORY_SUGGEST: User is a backend engineer working on insurance tech at PasarPolis
  MEMORY_SUGGEST: Project core is a Go monolith using chi router, GORM, MySQL
  USER_SUGGEST: User prefers concise bullet-point responses with no filler

**Rules:**
- Put markers at the VERY END of your response, after all other content
- One line per marker, no extra formatting
- Skip only if NOTHING memorable was established (routine greeting, simple yes/no)
- If you have facts to store, THIS is how — no other format accepted

**Consequence:** If you don't append markers, memory won't be saved and you'll have to re-learn everything next session.`;

  if (isFallback) {
    return base + `

⛔ **IMPORTANT:** You have missed 5+ consecutive opportunities to save memory. This is a hard requirement, not optional. Always end with markers.`;
  }

  return base;
}
