/**
 * Memory Store — File I/O for MEMORY.md and USER.md
 * Stores bounded, curated memory in ~/.9router/memory/{pool}/
 * 
 * Format (inspired by Hermes Agent):
 * - Entries separated by § (section sign)
 * - Header shows usage percentage
 * - Strict character limits enforced
 */

import fs from "fs/promises";
import path from "path";
import os from "os";

const MEMORY_DIR = path.join(os.homedir(), ".9router", "memory");
const MEMORY_CHAR_LIMIT = 2200;
const USER_CHAR_LIMIT = 1375;

/**
 * Load both memory files for a pool.
 * Creates the pool directory if it doesn't exist.
 * 
 * @param {string} pool - pool name (e.g. "warp", "opencode", "default")
 * @returns {Promise<{memory: string, user: string}>}
 */
export async function loadMemoryFiles(pool) {
  const poolDir = path.join(MEMORY_DIR, pool);

  try {
    await fs.mkdir(poolDir, { recursive: true });
  } catch {
    // Race: dir exists, continue
  }

  const [memoryContent, userContent] = await Promise.all([
    fs.readFile(path.join(poolDir, "MEMORY.md"), "utf-8").catch(() => ""),
    fs.readFile(path.join(poolDir, "USER.md"), "utf-8").catch(() => ""),
  ]);

  return { memory: memoryContent, user: userContent };
}

/**
 * Save one memory file.
 * 
 * @param {string} pool 
 * @param {"MEMORY"|"USER"} type 
 * @param {string} content 
 */
export async function saveMemoryFile(pool, type, content) {
  const poolDir = path.join(MEMORY_DIR, pool);
  await fs.mkdir(poolDir, { recursive: true });
  await fs.writeFile(path.join(poolDir, `${type}.md`), content, "utf-8");
}

/**
 * Append an entry to existing memory content.
 * Returns the new content. If over limit, triggers consolidation signal (truncates for now).
 * 
 * @param {string} currentContent 
 * @param {string} entry 
 * @param {"MEMORY"|"USER"} type 
 * @returns {{ content: string, wasTruncated: boolean }}
 */
export function appendEntry(currentContent, entry, type) {
  const limit = type === "USER" ? USER_CHAR_LIMIT : MEMORY_CHAR_LIMIT;
  const separator = currentContent ? "\n§\n" : "";
  const newContent = currentContent + separator + entry;

  if (newContent.length > limit) {
    return { content: newContent.slice(0, limit), wasTruncated: true };
  }

  return { content: newContent, wasTruncated: false };
}

/**
 * Get the file path for a pool file.
 * @param {string} pool 
 * @param {"MEMORY"|"USER"} type 
 * @returns {string}
 */
export function getMemoryPath(pool, type) {
  return path.join(MEMORY_DIR, pool, `${type}.md`);
}

export { MEMORY_DIR, MEMORY_CHAR_LIMIT, USER_CHAR_LIMIT };
