/**
 * Memory Module — Public API
 * 
 * Usage:
 *   import { loadMemoryForRequest, tryExtractFromResponse } from "@/lib/memory";
 * 
 * Request flow:
 *   1. loadMemoryForRequest(apiKey, messages) → injects memory into messages
 *   2. tryExtractFromResponse(apiKey, responseContent) → stores memory suggestions
 */

export { detectMemoryPool } from "./pool.js";
export { formatMemorySnippet, injectMemoryIntoMessages } from "./inject.js";
export { extractAndStoreFromResponse, parseMemorySuggestions } from "./extract.js";
export { getExtractionHint, recordExtractionAttempt, loadExtractionState, FALLBACK_THRESHOLD } from "./extract.js";
export { loadMemoryFiles, saveMemoryFile } from "./store.js";

import { detectMemoryPool } from "./pool.js";
import { loadMemoryFiles } from "./store.js";
import { formatMemorySnippet, injectMemoryIntoMessages } from "./inject.js";

/**
 * Convenience: load memory for a request and inject into messages.
 * 
 * @param {string|null} apiKey 
 * @param {Array} messages - request body messages (mutated in place)
 * @returns {Promise<{ injected: boolean, pool: string }>}
 */
export async function loadMemoryForRequest(apiKey, messages) {
  const pool = detectMemoryPool(apiKey);
  const { memory, user } = await loadMemoryFiles(pool);
  const memoryEntries = (memory || "").split("§").filter(Boolean).length;
  const userEntries = (user || "").split("§").filter(Boolean).length;
  const snippet = formatMemorySnippet(memory, user);

  if (snippet) {
    injectMemoryIntoMessages(messages, snippet);
    console.log(`[MEMORY] LOAD pool="${pool}" memory=${memoryEntries}entries/${(memory||"").length}chars user=${userEntries}entries/${(user||"").length}chars injected=true`);
    return { injected: true, pool };
  }

  console.log(`[MEMORY] LOAD pool="${pool}" memory=${memoryEntries}entries/${(memory||"").length}chars user=${userEntries}entries/${(user||"").length}chars injected=false`);
  return { injected: false, pool };
}

/**
 * Convenience: try to extract memory from a response.
 * 
 * @param {string} apiKey - to determine pool
 * @param {string} responseContent - assistant's response
 * @returns {Promise<{ memoryStored: boolean, userStored: boolean, pool: string }>}
 */
export async function tryExtractFromResponse(apiKey, responseContent) {
  const pool = detectMemoryPool(apiKey);
  const { extractAndStoreFromResponse } = await import("./extract.js");
  console.log(`[MEMORY] EXTRACT_START pool="${pool}" responseLen=${responseContent?.length||0}`);
  const result = await extractAndStoreFromResponse(responseContent, pool);
  console.log(`[MEMORY] EXTRACT_DONE pool="${pool}" memoryStored=${result.memoryStored} userStored=${result.userStored} attempted=${result.attempted}`);
  return { ...result, pool };
}
