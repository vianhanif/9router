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
 * Looks for:
 *   MEMORY_SUGGEST: <entry>
 *   USER_SUGGEST: <entry>
 * 
 * @param {string} responseContent - the assistant's response text
 * @returns {{ memory: string|null, user: string|null }}
 */
export function parseMemorySuggestions(responseContent) {
  if (!responseContent) return { memory: null, user: null };

  const memoryMatch = responseContent.match(/MEMORY_SUGGEST:\s*([\s\S]*?)(?=\nUSER_SUGGEST:|$)/i);
  const userMatch = responseContent.match(/USER_SUGGEST:\s*([\s\S]*?)(?=\nMEMORY_SUGGEST:|$)/i);

  return {
    memory: memoryMatch ? memoryMatch[1].trim() : null,
    user: userMatch ? userMatch[1].trim() : null,
  };
}

/**
 * Check if a memory suggestion is worth storing.
 * Filters out trivial / too short / obviously bad entries.
 * 
 * @param {string|null} entry 
 * @param {"MEMORY"|"USER"} type
 * @returns {boolean}
 */
export function isWorthStoring(entry, type) {
  if (!entry) return false;
  const trimmed = entry.trim();
  
  // Min length check
  if (trimmed.length < 10) return false;
  
  // Skip obvious question patterns
  if (trimmed.startsWith("?")) return false;
  
  // Skip code blocks
  if (trimmed.startsWith("```")) return false;
  
  // Skip entries that are just file paths without context
  if (/^~\/[\w\-\/]+$/.test(trimmed)) return false;
  
  return true;
}

/**
 * Extract and store memory from an LLM response.
 * Call this after getting the LLM response.
 * 
 * @param {string} responseContent - assistant's response text
 * @param {string} pool - memory pool name
 * @returns {Promise<{memoryStored: boolean, userStored: boolean, attempted: boolean}>}
 */
export async function extractAndStoreFromResponse(responseContent, pool) {
  const suggestions = parseMemorySuggestions(responseContent);
  
  // Check if LLM attempted extraction (markers present), regardless of whether we stored them
  const attempted = !!(suggestions.memory || suggestions.user);
  
  if (!suggestions.memory && !suggestions.user) {
    return { memoryStored: false, userStored: false, attempted: false };
  }

  const { memory: existingMemory, user: existingUser } = await loadMemoryFiles(pool);
  
  let memoryStored = false;
  let userStored = false;

  // MEMORY suggestions
  if (suggestions.memory && isWorthStoring(suggestions.memory, "MEMORY")) {
    if (!wouldBeDuplicate(existingMemory, suggestions.memory)) {
      const { content, wasTruncated } = appendEntry(existingMemory, suggestions.memory, "MEMORY");
      await saveMemoryFile(pool, "MEMORY", content);
      memoryStored = true;
      if (wasTruncated) {
        console.log(`[MEMORY] Pool "${pool}" MEMORY.md near capacity, truncated`);
      }
    }
  }

  // USER suggestions
  if (suggestions.user && isWorthStoring(suggestions.user, "USER")) {
    if (!wouldBeDuplicate(existingUser, suggestions.user)) {
      const { content, wasTruncated } = appendEntry(existingUser, suggestions.user, "USER");
      await saveMemoryFile(pool, "USER", content);
      userStored = true;
      if (wasTruncated) {
        console.log(`[MEMORY] Pool "${pool}" USER.md near capacity, truncated`);
      }
    }
  }

  return { memoryStored, userStored, attempted: true };
}

export const FALLBACK_THRESHOLD = 5;

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
    state.consecutiveMisses = wasStored ? 0 : (state.consecutiveMisses || 0) + 1;
    await fs.writeFile(statePath, JSON.stringify(state), "utf-8");
  } catch {
    // Ignore write errors
  }
}

/**
 * Build extraction hint text to append to the system prompt.
 * This tells the LLM how to format memory suggestions.
 * Reward-framing: telling the LLM this helps future sessions.
 * 
 * @param {"auto"|"explicit"} writeMode 
 * @param {boolean} isFallback - true if previous turns had no extraction
 * @returns {string}
 */
export function getExtractionHint(writeMode = "auto", isFallback = false) {
  if (writeMode === "explicit") {
    return "";
  }

  if (isFallback) {
    return `

---
## MEMORY EXTRACTION (important)

If the conversation established facts worth remembering across sessions, you MUST include these markers at the end of your response:

MEMORY_SUGGEST: <concise fact about environment, project, tool, or lesson learned>
USER_SUGGEST: <preference, communication style, or pet peeve the user demonstrated>

Not doing this means future sessions won't benefit from this context. Examples:
- USER_SUGGEST: User prefers bullet points over paragraphs
- MEMORY_SUGGEST: ~/code/api uses Prisma ORM with PostgreSQL

Skip only if nothing memorable was established.`;
  }

  return `

---
## MEMORY EXTRACTION

Good assistants learn from every session. If the conversation established facts worth remembering across sessions, append these markers to your response:

MEMORY_SUGGEST: <concise fact about environment, project, tool, or lesson learned>
USER_SUGGEST: <preference, communication style, or pet peeve the user demonstrated>

Future sessions will automatically receive this context, improving their responses. Examples:
- USER_SUGGEST: User prefers concise bullet-point responses, no filler text
- MEMORY_SUGGEST: Project ~/code/api uses Go 1.22, sqlc for DB queries, chi router

Skip if nothing memorable was established.`;
}
