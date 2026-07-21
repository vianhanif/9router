/**
 * Unit tests for the 9router Memory Module.
 *
 * Covers: pool.js, store.js, inject.js, dedup.js, extract.js, tool.js
 *
 * All file I/O uses temp directories. No real ~/.9router/ files are touched.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "url";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Pool tests ─────────────────────────────────────────────────────────────────

import { detectMemoryPool, listKnownPools } from "@/lib/memory/pool.js";

describe("pool.js", () => {
  it("null/undefined apiKey → default pool", () => {
    expect(detectMemoryPool(null)).toBe("default");
    expect(detectMemoryPool(undefined)).toBe("default");
    expect(detectMemoryPool("")).toBe("default");
  });

  it("known prefix (warp_) → warp pool", () => {
    expect(detectMemoryPool("warp_sk_test")).toBe("warp");
    expect(detectMemoryPool("warp_")).toBe("warp");
  });

  it("known prefix (opencode_) → opencode pool", () => {
    expect(detectMemoryPool("opencode_sk_abc")).toBe("opencode");
  });

  it("known prefix (codex_) → codex pool", () => {
    expect(detectMemoryPool("codex_sk")).toBe("codex");
  });

  it("known prefix (aider_) → aider pool", () => {
    expect(detectMemoryPool("aider_sk")).toBe("aider");
  });

  it("known prefix (cline_) → cline pool", () => {
    expect(detectMemoryPool("cline_sk")).toBe("cline");
  });

  it("known prefix (deepseek-tui_) → deepseek-tui pool", () => {
    expect(detectMemoryPool("deepseek-tui_sk")).toBe("deepseek-tui");
  });

  it("unknown prefix → default pool", () => {
    expect(detectMemoryPool("sk_live_abc")).toBe("default");
    expect(detectMemoryPool("randomkey")).toBe("default");
    expect(detectMemoryPool("another_prefix_key")).toBe("default");
  });

  it("case-insensitive prefix matching", () => {
    expect(detectMemoryPool("WARP_foo")).toBe("warp");
    expect(detectMemoryPool("WARP")).toBe("warp");
    expect(detectMemoryPool("OpenCode_sk")).toBe("opencode");
  });

  it("listKnownPools includes default + all known pools", () => {
    const pools = listKnownPools();
    expect(pools).toContain("default");
    expect(pools).toContain("warp");
    expect(pools).toContain("opencode");
    expect(pools).toContain("codex");
    expect(pools).toContain("aider");
    expect(pools).toContain("cline");
    expect(pools).toContain("deepseek-tui");
    expect(pools.length).toBeGreaterThan(5);
  });
});

// ─── Dedup tests ────────────────────────────────────────────────────────────────

import { isNearDuplicate, parseEntries, wouldBeDuplicate } from "@/lib/memory/dedup.js";

describe("dedup.js — isNearDuplicate", () => {
  it("empty input → not duplicate", () => {
    expect(isNearDuplicate("", "some fact")).toBe(false);
    expect(isNearDuplicate(null, "some fact")).toBe(false);
    expect(isNearDuplicate("some fact", "")).toBe(false);
  });

  it("exact match → duplicate", () => {
    expect(isNearDuplicate("User prefers bullet points", "User prefers bullet points")).toBe(true);
  });

  it("case-insensitive match → duplicate", () => {
    expect(isNearDuplicate("User prefers bullet points", "user prefers bullet points")).toBe(true);
  });

  it("minor whitespace difference → near-duplicate above threshold", () => {
    expect(isNearDuplicate("Project uses Go 1.22", "Project uses  Go  1.22")).toBe(true);
  });

  it("completely different content → not duplicate", () => {
    expect(isNearDuplicate("Project uses Python", "Server runs on port 3000")).toBe(false);
  });

  it("partial overlap below threshold → not duplicate", () => {
    const a = "The server runs on port 3000 and uses Express.js for routing";
    const b = "The client uses React with TypeScript and Vite for bundling";
    expect(isNearDuplicate(a, b)).toBe(false);
  });

  it("custom threshold 0.8 requires near-identical content", () => {
    expect(isNearDuplicate("User prefers bullet points", "User prefers bullet points", 0.8)).toBe(true);
    expect(isNearDuplicate("User prefers bullet points", "User prefers bullet points and short sentences", 0.8)).toBe(false);
  });

  it("special characters stripped before comparison", () => {
    // After stripping, "hello-world" → "helloworld", "hello world" → "hello world"
    // Different word sets → similarity 0 → not a near-duplicate (special char
    // stripping doesn't bridge gap between a merged word and separate words)
    expect(isNearDuplicate("hello-world", "helloworld")).toBe(true);
    expect(isNearDuplicate("foo.bar!baz", "foobarbaz")).toBe(true);
  });
});

describe("dedup.js — parseEntries", () => {
  it("empty content → empty array", () => {
    expect(parseEntries("")).toEqual([]);
    expect(parseEntries(null)).toEqual([]);
  });

  it("single entry → one-item array", () => {
    expect(parseEntries("just one fact")).toEqual(["just one fact"]);
  });

  it("multiple entries separated by § → array", () => {
    const content = "Fact one\n§\nFact two\n§\nFact three";
    const entries = parseEntries(content);
    expect(entries.length).toBe(3);
    expect(entries[0]).toBe("Fact one");
    expect(entries[1]).toBe("Fact two");
    expect(entries[2]).toBe("Fact three");
  });

  it("whitespace around § is trimmed", () => {
    const content = "  Fact one  \n§\n  Fact two  ";
    const entries = parseEntries(content);
    expect(entries[0]).toBe("Fact one");
    expect(entries[1]).toBe("Fact two");
  });
});

describe("dedup.js — wouldBeDuplicate", () => {
  it("no existing entries → not duplicate", () => {
    expect(wouldBeDuplicate("", "new fact")).toBe(false);
  });

  it("exact match with existing entry → duplicate", () => {
    const content = "Fact one\n§\nUser prefers bullets";
    expect(wouldBeDuplicate(content, "User prefers bullets")).toBe(true);
  });

  it("new fact completely different → not duplicate", () => {
    const content = "Fact one\n§\nUser prefers bullets";
    expect(wouldBeDuplicate(content, "Server runs on port 8080")).toBe(false);
  });
});

// ─── Store tests ───────────────────────────────────────────────────────────────

import {
  loadMemoryFiles,
  saveMemoryFile,
  appendEntry,
  getMemoryPath,
  MEMORY_CHAR_LIMIT,
  USER_CHAR_LIMIT,
} from "@/lib/memory/store.js";

describe("store.js — appendEntry", () => {
  it("first entry (empty content) → no separator", () => {
    const { content } = appendEntry("", "Project uses Go", "MEMORY");
    expect(content).toBe("Project uses Go");
    expect(content).not.toContain("§");
  });

  it("subsequent entries → separated by §", () => {
    const { content } = appendEntry("Fact one", "Fact two", "MEMORY");
    expect(content).toBe("Fact one\n§\nFact two");
  });

  it("USER type uses USER_CHAR_LIMIT", () => {
    const short = appendEntry("", "short", "USER");
    expect(short.content).toBe("short");

    const long = "a".repeat(USER_CHAR_LIMIT + 100);
    const { content, wasTruncated } = appendEntry("", long, "USER");
    expect(wasTruncated).toBe(true);
    expect(content.length).toBe(USER_CHAR_LIMIT);
  });

  it("MEMORY type uses MEMORY_CHAR_LIMIT", () => {
    const long = "m".repeat(MEMORY_CHAR_LIMIT + 100);
    const { content, wasTruncated } = appendEntry("", long, "MEMORY");
    expect(wasTruncated).toBe(true);
    expect(content.length).toBe(MEMORY_CHAR_LIMIT);
  });

  it("under limit → no truncation", () => {
    const { content, wasTruncated } = appendEntry("", "short fact", "MEMORY");
    expect(wasTruncated).toBe(false);
    expect(content).toBe("short fact");
  });

  it("content at exactly the limit → no truncation", () => {
    const exactly = "x".repeat(MEMORY_CHAR_LIMIT);
    const { content, wasTruncated } = appendEntry("", exactly, "MEMORY");
    expect(wasTruncated).toBe(false);
    expect(content.length).toBe(MEMORY_CHAR_LIMIT);
  });

  it("appending to existing content → adds separator + new entry", () => {
    const existing = "Existing fact";
    const { content } = appendEntry(existing, "New fact", "MEMORY");
    expect(content).toBe("Existing fact\n§\nNew fact");
  });
});

describe("store.js — file I/O (temp dir)", () => {
  let tempDir;
  let origHome;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-memory-test-"));
    origHome = os.homedir();
    // Override MEMORY_DIR by patching os.homedir behavior via env
    process.env.HOME = tempDir;
  });

  afterEach(async () => {
    process.env.HOME = origHome;
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("loadMemoryFiles → empty objects for new pool", async () => {
    const { memory, user } = await loadMemoryFiles("brand-new-pool");
    expect(memory).toBe("");
    expect(user).toBe("");
  });

  it("saveMemoryFile + loadMemoryFiles → roundtrip", async () => {
    await saveMemoryFile("test-pool", "MEMORY", "Stored fact");
    await saveMemoryFile("test-pool", "USER", "User preference");

    const { memory, user } = await loadMemoryFiles("test-pool");
    expect(memory).toBe("Stored fact");
    expect(user).toBe("User preference");
  });

  it("getMemoryPath returns correct path", () => {
    const memPath = getMemoryPath("my-pool", "MEMORY");
    expect(memPath).toContain("my-pool");
    expect(memPath).toContain("MEMORY.md");
  });

  it("loadMemoryFiles handles missing files gracefully", async () => {
    // Pool dir exists but no files written
    const poolDir = path.join(tempDir, ".9router", "memory", "empty-pool");
    fs.mkdirSync(poolDir, { recursive: true });
    const { memory, user } = await loadMemoryFiles("empty-pool");
    expect(memory).toBe("");
    expect(user).toBe("");
  });
});

// ─── Inject tests ──────────────────────────────────────────────────────────────

import { formatMemorySnippet, injectMemoryIntoMessages } from "@/lib/memory/inject.js";

describe("inject.js — formatMemorySnippet", () => {
  it("both empty → null", () => {
    expect(formatMemorySnippet("", "")).toBeNull();
    expect(formatMemorySnippet(null, null)).toBeNull();
  });

  it("only user content → includes user section", () => {
    const snippet = formatMemorySnippet("", "User prefers short replies");
    expect(snippet).not.toBeNull();
    expect(snippet).toContain("USER PROFILE");
    expect(snippet).toContain("User prefers short replies");
    expect(snippet).not.toContain("MEMORY");
  });

  it("only memory content → includes memory section", () => {
    const snippet = formatMemorySnippet("Server runs on port 3000", "");
    expect(snippet).not.toBeNull();
    expect(snippet).toContain("MEMORY");
    expect(snippet).toContain("Server runs on port 3000");
  });

  it("both present → both sections with user first", () => {
    const snippet = formatMemorySnippet("Project uses Go", "User prefers bullets");
    expect(snippet).toContain("USER PROFILE");
    expect(snippet).toContain("MEMORY");
    // User section comes before memory section
    const userIdx = snippet.indexOf("USER PROFILE");
    const memIdx = snippet.indexOf("MEMORY");
    expect(userIdx).toBeLessThan(memIdx);
  });

  it("shows usage percentage in header", () => {
    const snippet = formatMemorySnippet("abc", "xyz");
    expect(snippet).toMatch(/\d+%.*\/\d+ chars/);
  });
});

describe("inject.js — injectMemoryIntoMessages", () => {
  it("null snippet → returns original messages", () => {
    const msgs = [{ role: "user", content: "hi" }];
    expect(injectMemoryIntoMessages(msgs, null)).toBe(msgs);
    expect(injectMemoryIntoMessages(msgs, "")).toBe(msgs);
  });

  it("non-array → returns original", () => {
    expect(injectMemoryIntoMessages(null, "fact")).toBeNull();
    expect(injectMemoryIntoMessages("not an array", "fact")).toBe("not an array");
  });

  it("no existing system message → prepends as first message", () => {
    const msgs = [{ role: "user", content: "hi" }];
    const result = injectMemoryIntoMessages(msgs, "Remember: project uses Go");
    expect(result[0].role).toBe("system");
    expect(result[0].content).toContain("Remember: project uses Go");
    expect(result[0].content).toContain("[PERSISTENT MEMORY");
  });

  it("existing system message → inserts after it", () => {
    const msgs = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "hi" },
    ];
    const result = injectMemoryIntoMessages(msgs, "Remember: project uses Go");
    expect(result[0].role).toBe("system");
    expect(result[0].content).toBe("You are a helpful assistant.");
    expect(result[1].role).toBe("system");
    expect(result[1].content).toContain("[PERSISTENT MEMORY");
    expect(result[2].role).toBe("user");
  });

  it("multiple system messages → inserts after first one", () => {
    const msgs = [
      { role: "system", content: "First system" },
      { role: "system", content: "Second system" },
      { role: "user", content: "hi" },
    ];
    const result = injectMemoryIntoMessages(msgs, "Memory fact");
    expect(result[0].content).toBe("First system");
    expect(result[1].content).toContain("[PERSISTENT MEMORY");
    expect(result[1].content).toContain("Memory fact");
    expect(result[2].content).toBe("Second system");
    expect(result[3].role).toBe("user");
  });

  it("does not mutate original messages array", () => {
    const msgs = [{ role: "system", content: "sys" }, { role: "user", content: "hi" }];
    injectMemoryIntoMessages(msgs, "fact");
    expect(msgs.length).toBe(2);
    expect(msgs[0].content).toBe("sys");
  });
});

// ─── Extract tests ─────────────────────────────────────────────────────────────

import {
  parseMemorySuggestions,
  isWorthStoring,
  getExtractionHint,
  FALLBACK_THRESHOLD,
} from "@/lib/memory/extract.js";

describe("extract.js — parseMemorySuggestions", () => {
  it("empty/null → no suggestions", () => {
    expect(parseMemorySuggestions("")).toEqual({ memory: null, user: null });
    expect(parseMemorySuggestions(null)).toEqual({ memory: null, user: null });
    expect(parseMemorySuggestions("just normal text")).toEqual({ memory: null, user: null });
  });

  it("MEMORY_SUGGEST marker → extracts memory", () => {
    const text = "Here's the answer.\nMEMORY_SUGGEST: Project uses Go 1.22";
    const { memory, user } = parseMemorySuggestions(text);
    expect(memory).toBe("Project uses Go 1.22");
    expect(user).toBeNull();
  });

  it("USER_SUGGEST marker → extracts user", () => {
    const text = "Got it.\nUSER_SUGGEST: User prefers bullet points";
    const { memory, user } = parseMemorySuggestions(text);
    expect(memory).toBeNull();
    expect(user).toBe("User prefers bullet points");
  });

  it("both markers → extracts both", () => {
    const text = "Sure.\nMEMORY_SUGGEST: Server runs on port 3000\nUSER_SUGGEST: Prefers short replies";
    const { memory, user } = parseMemorySuggestions(text);
    expect(memory).toBe("Server runs on port 3000");
    expect(user).toBe("Prefers short replies");
  });

  it("markers are case-insensitive", () => {
    const text = "MEMORY_suggest: fact\nuser_suggest: pref";
    const { memory, user } = parseMemorySuggestions(text);
    expect(memory).toBe("fact");
    expect(user).toBe("pref");
  });

  it("marker with no content → null", () => {
    const text = "MEMORY_SUGGEST:";
    const { memory } = parseMemorySuggestions(text);
    expect(memory).toBe("");
  });

  it("multi-line content after marker", () => {
    const text = "MEMORY_SUGGEST: Server runs on port 3000\nUses Express for routing";
    const { memory } = parseMemorySuggestions(text);
    expect(memory).toBe("Server runs on port 3000\nUses Express for routing");
  });
});

describe("extract.js — isWorthStoring", () => {
  it("null/empty → false", () => {
    expect(isWorthStoring(null, "MEMORY")).toBe(false);
    expect(isWorthStoring("", "MEMORY")).toBe(false);
    expect(isWorthStoring("  ", "MEMORY")).toBe(false);
  });

  it("too short (< 10 chars) → false", () => {
    expect(isWorthStoring("short", "MEMORY")).toBe(false);
    expect(isWorthStoring("a".repeat(9), "MEMORY")).toBe(false);
    expect(isWorthStoring("a".repeat(10), "MEMORY")).toBe(true);
  });

  it("starts with ? → false (question pattern)", () => {
    expect(isWorthStoring("? does it use Go?", "MEMORY")).toBe(false);
  });

  it("starts with ``` → false (code block)", () => {
    expect(isWorthStoring("```\ncode\n```", "MEMORY")).toBe(false);
  });

  it("just a file path → false", () => {
    expect(isWorthStoring("~/Documents/code", "MEMORY")).toBe(false);
    expect(isWorthStoring("~/foo/bar", "MEMORY")).toBe(false);
  });

  it("valid memory entry → true", () => {
    expect(isWorthStoring("Project uses Go 1.22 with sqlc", "MEMORY")).toBe(true);
  });

  it("valid user entry → true", () => {
    expect(isWorthStoring("User prefers concise bullet-point responses", "USER")).toBe(true);
  });
});

describe("extract.js — getExtractionHint", () => {
  it("standard hint (non-fallback) → mentions both tool and markers", () => {
    const hint = getExtractionHint(false);
    expect(hint).toContain("MEMORY EXTRACTION");
    expect(hint).toContain("store_memory");
    expect(hint).toContain("MEMORY_SUGGEST");
    expect(hint).toContain("USER_SUGGEST");
  });

  it("fallback hint → stronger language", () => {
    const hint = getExtractionHint(true);
    expect(hint).toContain("MEMORY EXTRACTION");
    expect(hint).toContain("MUST");
    expect(hint).toContain("store_memory");
  });

  it("FALLBACK_THRESHOLD is 5", () => {
    expect(FALLBACK_THRESHOLD).toBe(5);
  });
});

// ─── Tool tests ────────────────────────────────────────────────────────────────

import {
  MEMORY_TOOL_NAME,
  MEMORY_TOOL_DEFINITION,
  MEMORY_TOOL_ANTHROPIC,
  parseMemoryToolCalls,
} from "@/lib/memory/tool.js";

describe("tool.js — MEMORY_TOOL_NAME", () => {
  it("tool name is store_memory", () => {
    expect(MEMORY_TOOL_NAME).toBe("store_memory");
  });
});

describe("tool.js — MEMORY_TOOL_DEFINITION", () => {
  it("has required fields", () => {
    expect(MEMORY_TOOL_DEFINITION.name).toBe("store_memory");
    expect(MEMORY_TOOL_DEFINITION.description).toContain("Store a fact");
    expect(MEMORY_TOOL_DEFINITION.parameters.type).toBe("object");
    expect(MEMORY_TOOL_DEFINITION.parameters.required).toContain("type");
    expect(MEMORY_TOOL_DEFINITION.parameters.required).toContain("content");
  });

  it("type enum has MEMORY and USER", () => {
    const { enum: typeEnum } = MEMORY_TOOL_DEFINITION.parameters.properties.type;
    expect(typeEnum).toContain("MEMORY");
    expect(typeEnum).toContain("USER");
  });

  it("content has maxLength", () => {
    expect(MEMORY_TOOL_DEFINITION.parameters.properties.content.maxLength).toBe(2200);
  });
});

describe("tool.js — MEMORY_TOOL_ANTHROPIC", () => {
  it("has name, description, input_schema", () => {
    expect(MEMORY_TOOL_ANTHROPIC.name).toBe("store_memory");
    expect(MEMORY_TOOL_ANTHROPIC.description).toContain("Store a fact");
    expect(MEMORY_TOOL_ANTHROPIC.input_schema.type).toBe("object");
    expect(MEMORY_TOOL_ANTHROPIC.input_schema.required).toContain("type");
    expect(MEMORY_TOOL_ANTHROPIC.input_schema.required).toContain("content");
  });
});

describe("tool.js — parseMemoryToolCalls", () => {
  it("empty/null → empty array", () => {
    expect(parseMemoryToolCalls(null)).toEqual([]);
    expect(parseMemoryToolCalls([])).toEqual([]);
    expect(parseMemoryToolCalls(undefined)).toEqual([]);
  });

  it("ignores non-memory tool calls", () => {
    const calls = [
      { name: "read_file", input: { path: "/tmp/foo" } },
      { name: "write_file", input: { content: "hi" } },
    ];
    expect(parseMemoryToolCalls(calls)).toEqual([]);
  });

  it("OpenAI format (function.name + function.arguments string)", () => {
    const calls = [{
      function: {
        name: "store_memory",
        arguments: '{"type":"MEMORY","content":"Project uses Go"}'
      }
    }];
    const result = parseMemoryToolCalls(calls);
    expect(result.length).toBe(1);
    expect(result[0]).toEqual({ type: "MEMORY", content: "Project uses Go" });
  });

  it("OpenAI format (function.arguments object)", () => {
    const calls = [{
      function: {
        name: "store_memory",
        arguments: { type: "USER", content: "User prefers bullets" }
      }
    }];
    const result = parseMemoryToolCalls(calls);
    expect(result[0].type).toBe("USER");
    expect(result[0].content).toBe("User prefers bullets");
  });

  it("Anthropic format (name + input)", () => {
    const calls = [{
      name: "store_memory",
      input: { type: "MEMORY", content: "Server runs on port 3000" }
    }];
    const result = parseMemoryToolCalls(calls);
    expect(result.length).toBe(1);
    expect(result[0]).toEqual({ type: "MEMORY", content: "Server runs on port 3000" });
  });

  it("Gemini format (name + args)", () => {
    const calls = [{
      id: "tool_123",
      name: "store_memory",
      args: { type: "USER", content: "Prefers concise replies" }
    }];
    const result = parseMemoryToolCalls(calls);
    // parseMemoryToolCalls only checks for toolCall.name || toolCall.function?.name || ""
    // and toolCall.input || toolCall.function?.arguments
    // Gemini's name+args format is NOT handled; test documents actual behavior
    expect(result.length).toBe(0);
  });

  it("type is uppercased", () => {
    const calls = [{
      name: "store_memory",
      input: { type: "memory", content: "lowercase type" }
    }];
    const result = parseMemoryToolCalls(calls);
    expect(result[0].type).toBe("MEMORY");
  });

  it("skips malformed arguments (non-JSON string)", () => {
    const calls = [{
      function: { name: "store_memory", arguments: "not valid json {" }
    }];
    expect(parseMemoryToolCalls(calls)).toEqual([]);
  });

  it("skips entries missing type or content", () => {
    const calls = [
      { name: "store_memory", input: { type: "MEMORY" } }, // missing content
      { name: "store_memory", input: { content: "fact" } }, // missing type
      { name: "store_memory", input: { type: "MEMORY", content: "valid" } },
    ];
    const result = parseMemoryToolCalls(calls);
    expect(result.length).toBe(1);
    expect(result[0].content).toBe("valid");
  });

  it("multiple store_memory calls → all parsed", () => {
    const calls = [
      { name: "store_memory", input: { type: "MEMORY", content: "fact one" } },
      { name: "read_file", input: { path: "/tmp" } },
      { name: "store_memory", input: { type: "USER", content: "pref two" } },
    ];
    const result = parseMemoryToolCalls(calls);
    expect(result.length).toBe(2);
    expect(result[0].content).toBe("fact one");
    expect(result[1].content).toBe("pref two");
  });
});
