/**
 * Memory Injection — Format and inject memory snippet into request messages.
 * Appends memory as a system message after the existing system message (or at top).
 */

import { MEMORY_CHAR_LIMIT, USER_CHAR_LIMIT } from "./store.js";

/**
 * Format memory content into a display-ready snippet.
 * 
 * @param {string} memoryContent — MEMORY.md content
 * @param {string} userContent — USER.md content
 * @returns {string|null} formatted snippet or null if both empty
 */
export function formatMemorySnippet(memoryContent, userContent) {
  if (!memoryContent && !userContent) return null;

  const memoryChars = memoryContent?.length || 0;
  const userChars = userContent?.length || 0;

  let snippet = "";

  if (userContent) {
    snippet += `══════════════════════════════════════════════\n`;
    snippet += `USER PROFILE [${Math.round(userChars / USER_CHAR_LIMIT * 100)}% — ${userChars}/${USER_CHAR_LIMIT} chars]\n`;
    snippet += `══════════════════════════════════════════════\n`;
    snippet += userContent.trim() + "\n";
  }

  if (memoryContent) {
    if (snippet) snippet += "\n";
    snippet += `══════════════════════════════════════════════\n`;
    snippet += `MEMORY [${Math.round(memoryChars / MEMORY_CHAR_LIMIT * 100)}% — ${memoryChars}/${MEMORY_CHAR_LIMIT} chars]\n`;
    snippet += `══════════════════════════════════════════════\n`;
    snippet += memoryContent.trim();
  }

  return snippet;
}

/**
 * Inject memory snippet into messages array.
 * Appends as a system message after existing system message (or prepends if none).
 * Marked with [PERSISTENT MEMORY] to let the LLM treat it as read-only context.
 * 
 * @param {Array} messages - messages array from the request body
 * @param {string} memorySnippet - formatted memory snippet
 * @returns {Array} new messages array with memory injected
 */
export function injectMemoryIntoMessages(messages, memorySnippet) {
  if (!memorySnippet || !Array.isArray(messages)) return messages;

  const systemIdx = messages.findIndex(m => m.role === "system");

  const memoryMessage = {
    role: "system",
    content: `[PERSISTENT MEMORY — PRESERVE FACTS, UPDATE WHEN CONFIRMED]\n\n${memorySnippet}`
  };

  if (systemIdx >= 0) {
    const newMessages = [...messages];
    newMessages.splice(systemIdx + 1, 0, memoryMessage);
    return newMessages;
  }

  return [memoryMessage, ...messages];
}
