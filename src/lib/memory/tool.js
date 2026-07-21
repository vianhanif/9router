/**
 * Memory Tool Definition
 *
 * A tool that the LLM can call to store memory entries directly.
 * This works for tool-use / agent-mode conversations where the LLM
 * doesn't output prose that could carry MEMORY_SUGGEST markers.
 *
 * The tool is injected into the request's tools array by the chat handler.
 * When the LLM calls it, the tool call is intercepted and the entry is stored.
 */

export const MEMORY_TOOL_NAME = "store_memory";

/**
 * Tool definition for OpenAI / Anthropic / Gemini compatible formats.
 * This is injected into the request's tools array.
 */
export const MEMORY_TOOL_DEFINITION = {
  name: MEMORY_TOOL_NAME,
  description: "Store a fact about the user's environment, tools, or preferences for future sessions. Call this when you learn something worth remembering across sessions — not for every fact, only for things that would genuinely help future conversations. Categories: environment (OS, paths, tools), project (stack, patterns, conventions), lessons (learned decisions, gotchas), user (preferences, communication style, pet peeves).",
  parameters: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["MEMORY", "USER"],
        description: "Category of the memory entry. Use MEMORY for environment/project facts. Use USER for user preferences and communication style."
      },
      content: {
        type: "string",
        description: "The memory entry to store. Be concise (under 100 chars). No formatting, just the fact.",
        maxLength: 2200
      }
    },
    required: ["type", "content"]
  }
};

/**
 * Tool definition in Anthropic format (Claude).
 */
export const MEMORY_TOOL_ANTHROPIC = {
  name: MEMORY_TOOL_NAME,
  description: "Store a fact about the user's environment, tools, or preferences for future sessions. Call this when you learn something worth remembering across sessions.",
  input_schema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["MEMORY", "USER"],
        description: "Category: MEMORY for environment/project facts, USER for user preferences."
      },
      content: {
        type: "string",
        description: "The memory entry to store. Concise, under 100 chars.",
        maxLength: 2200
      }
    },
    required: ["type", "content"]
  }
};

/**
 * Parse store_memory tool calls from accumulated tool calls.
 *
 * @param {Array} accumulatedToolCalls - array of tool call objects
 * @returns {Array<{type: string, content: string}>} parsed entries
 */
export function parseMemoryToolCalls(accumulatedToolCalls) {
  if (!Array.isArray(accumulatedToolCalls) || accumulatedToolCalls.length === 0) {
    return [];
  }

  const entries = [];

  for (const toolCall of accumulatedToolCalls) {
    // Match by tool name (various formats across providers)
    const name = toolCall.name || toolCall.function?.name || "";
    if (name !== MEMORY_TOOL_NAME) continue;

    // Extract arguments
    let args = {};
    if (toolCall.input) {
      args = toolCall.input;
    } else if (toolCall.function?.arguments) {
      const rawArgs = toolCall.function.arguments;
      try {
        args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
      } catch {
        continue; // Skip malformed arguments
      }
    }

    const { type, content } = args;
    if (type && content && typeof content === "string") {
      entries.push({ type: type.toUpperCase(), content: content.trim() });
    }
  }

  return entries;
}

import { loadMemoryFiles, saveMemoryFile, appendEntry } from "./store.js";
import { wouldBeDuplicate } from "./dedup.js";

/**
 * Store memory entries from store_memory tool calls.
 * Bypasses the quality/isWorthStoring filter since the LLM already
 * decided these are worth calling a tool for.
 * Still checks dedup.
 *
 * @param {Array<{type: string, content: string}>} entries
 * @param {string} pool
 * @returns {Promise<{memoryStored: boolean, userStored: boolean}>}
 */
export async function storeFromToolCalls(entries, pool) {
  if (!entries || entries.length === 0) {
    return { memoryStored: false, userStored: false };
  }

  const files = await loadMemoryFiles(pool);
  let existingMemory = files.memory;
  let existingUser = files.user;

  let memoryStored = false;
  let userStored = false;

  for (const entry of entries) {
    if (entry.type === "MEMORY") {
      if (!wouldBeDuplicate(existingMemory, entry.content)) {
        const { content, wasTruncated } = appendEntry(existingMemory, entry.content, "MEMORY");
        await saveMemoryFile(pool, "MEMORY", content);
        existingMemory = content;
        memoryStored = true;
        console.log(`[MEMORY] TOOL_STORED pool="${pool}" type=MEMORY entry="${entry.content.slice(0, 100)}"${wasTruncated ? " truncated" : ""}`);
      } else {
        console.log(`[MEMORY] TOOL_SKIPPED pool="${pool}" type=MEMORY reason=duplicate`);
      }
    } else if (entry.type === "USER") {
      if (!wouldBeDuplicate(existingUser, entry.content)) {
        const { content, wasTruncated } = appendEntry(existingUser, entry.content, "USER");
        await saveMemoryFile(pool, "USER", content);
        existingUser = content;
        userStored = true;
        console.log(`[MEMORY] TOOL_STORED pool="${pool}" type=USER entry="${entry.content.slice(0, 100)}"${wasTruncated ? " truncated" : ""}`);
      } else {
        console.log(`[MEMORY] TOOL_SKIPPED pool="${pool}" type=USER reason=duplicate`);
      }
    }
  }

  return { memoryStored, userStored };
}
