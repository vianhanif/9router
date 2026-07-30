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
 * @returns {Promise<{memoryStored: boolean, userStored: boolean, attempted: boolean}>}
 */
export async function extractAndStoreFromResponse(responseContent, pool) {
  const suggestions = parseMemorySuggestions(responseContent);
  
  // Check if LLM attempted extraction (markers present), regardless of whether we stored them
  const attempted = !!(suggestions.memory || suggestions.user);
  
  if (!suggestions.memory && !suggestions.user) {
    return { memoryStored: false, userStored: false, attempted: false };
  }

  console.log(`[MEMORY] MARKERS_FOUND pool="${pool}" memory=${!!suggestions.memory} user=${!!suggestions.user} memoryPreview="${(suggestions.memory||"").slice(0,80)}" userPreview="${(suggestions.user||"").slice(0,80)}"`);

  const { memory: existingMemory, user: existingUser } = await loadMemoryFiles(pool);
  
  let memoryStored = false;
  let userStored = false;
  let memorySkipped = null;
  let userSkipped = null;

  // MEMORY suggestions
  if (suggestions.memory) {
    if (!isWorthStoring(suggestions.memory, "MEMORY")) {
      memorySkipped = "not-worth-storing";
    } else if (wouldBeDuplicate(existingMemory, suggestions.memory)) {
      memorySkipped = "duplicate";
    } else {
      const { content, wasTruncated } = appendEntry(existingMemory, suggestions.memory, "MEMORY");
      await saveMemoryFile(pool, "MEMORY", content);
      memoryStored = true;
      console.log(`[MEMORY] STORED pool="${pool}" type=MEMORY entry="${suggestions.memory.slice(0, 100)}"${wasTruncated ? " truncated=true" : ""}`);
    }
  }

  // USER suggestions
  if (suggestions.user) {
    if (!isWorthStoring(suggestions.user, "USER")) {
      userSkipped = "not-worth-storing";
    } else if (wouldBeDuplicate(existingUser, suggestions.user)) {
      userSkipped = "duplicate";
    } else {
      const { content, wasTruncated } = appendEntry(existingUser, suggestions.user, "USER");
      await saveMemoryFile(pool, "USER", content);
      userStored = true;
      console.log(`[MEMORY] STORED pool="${pool}" type=USER entry="${suggestions.user.slice(0, 100)}"${wasTruncated ? " truncated=true" : ""}`);
    }
  }

  if (memorySkipped || userSkipped) {
    const skipped = [memorySkipped && `MEMORY=${memorySkipped}`, userSkipped && `USER=${userSkipped}`].filter(Boolean).join(" ");
    console.log(`[MEMORY] SKIPPED pool="${pool}" ${skipped}`);
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
