/**
 * Memory Pool Detection
 * Maps API key prefix to memory pool name.
 * Falls back to "default" for unknown prefixes.
 */

const KNOWN_POOLS = ["warp", "opencode", "codex", "aider", "cline", "deepseek-tui"];

/**
 * Detect memory pool from API key.
 * Uses the first segment of the key (split by underscore) as the pool name.
 * 
 * @param {string|null} apiKey
 * @returns {string} pool name
 */
export function detectMemoryPool(apiKey) {
  if (!apiKey) return "default";

  const prefix = apiKey.split("_")[0].toLowerCase();

  return KNOWN_POOLS.includes(prefix) ? prefix : "default";
}

/**
 * List all known pool names.
 * @returns {string[]}
 */
export function listKnownPools() {
  return ["default", ...KNOWN_POOLS];
}
