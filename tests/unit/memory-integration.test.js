import { describe, it, expect, vi } from "vitest";

// Use async importOriginal to preserve side-effect exports (register, etc.)
vi.mock("@9router/core/translator/index.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    needsTranslation: vi.fn(() => false),
  };
});

vi.mock("@9router/core/config/runtimeConfig.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
  };
});

vi.mock("@9router/core/utils/error.js", () => ({
  createErrorResult: vi.fn((status, msg) => ({ success: false, error: msg, status })),
}));

vi.mock("@9router/core/utils/usageTracking.js", () => ({
  addBufferToUsage: vi.fn(u => u),
  filterUsageForFormat: vi.fn(u => u),
}));

vi.mock("@9router/core/utils/claudeCloaking.js", () => ({
  decloakToolNames: vi.fn((body) => body),
}));

vi.mock("@9router/core/handlers/chatCore/requestDetail.js", () => ({
  extractUsageFromResponse: vi.fn(() => ({ prompt_tokens: 0, completion_tokens: 0 })),
  buildRequestDetail: vi.fn(() => ({})),
  extractRequestConfig: vi.fn(() => ({})),
  saveUsageStats: vi.fn(),
}));

// Import @9router/db separately since it has real dependencies (sqlite etc.
// that we must not load). Mock it fully before any module imports it.
vi.mock("@9router/db", () => ({
  appendRequestLog: vi.fn(() => ({ catch: vi.fn() })),
  saveRequestDetail: vi.fn(() => ({ catch: vi.fn() })),
}));

import { handleNonStreamingResponse } from "@9router/core/handlers/chatCore/nonStreamingHandler.js";

describe("memory integration — nonStreamingHandler", () => {
  it("triggers callback with response content", async () => {
    const onNonStreamingComplete = vi.fn();
    const mockResponse = {
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({ choices: [{ message: { content: "Test content" } }] }),
    };
    
    await handleNonStreamingResponse({
      providerResponse: mockResponse,
      reqLogger: { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() },
      trackDone: vi.fn(),
      appendLog: vi.fn(),
      onNonStreamingComplete
    });

    expect(onNonStreamingComplete).toHaveBeenCalledWith("Test content");
  });

  it("skips callback when not provided", async () => {
    const mockResponse = {
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({ choices: [{ message: { content: "Test" } }] }),
    };
    
    await expect(handleNonStreamingResponse({
      providerResponse: mockResponse,
      reqLogger: { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() },
      trackDone: vi.fn(),
      appendLog: vi.fn(),
    })).resolves.toBeDefined();
  });

  it("handles null content gracefully", async () => {
    const onNonStreamingComplete = vi.fn();
    const mockResponse = {
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({ choices: [{ message: {} }] }),
    };
    
    await handleNonStreamingResponse({
      providerResponse: mockResponse,
      reqLogger: { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() },
      trackDone: vi.fn(),
      appendLog: vi.fn(),
      onNonStreamingComplete
    });

    expect(onNonStreamingComplete).toHaveBeenCalledWith(null);
  });
});
