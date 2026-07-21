import "@9router/core/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { cacheClaudeHeaders } from "@9router/core/utils/claudeHeaderCache.js";
import { getSettings } from "@9router/db";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "@9router/core/handlers/chatCore.js";
import { errorResponse, unavailableResponse } from "@9router/core/utils/error.js";
import { handleComboChat, handleFusionChat } from "@9router/core/services/combo.js";
import { handleBypassRequest } from "@9router/core/utils/bypassHandler.js";
import { HTTP_STATUS } from "@9router/core/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "@9router/core/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "@9router/core/services/projectId.js";
import { loadMemoryForRequest, tryExtractFromResponse, getExtractionHint, loadExtractionState, recordExtractionAttempt, FALLBACK_THRESHOLD, detectMemoryPool } from "../lib/memory/index.js";
import { MEMORY_TOOL_DEFINITION, MEMORY_TOOL_NAME, parseMemoryToolCalls } from "../lib/memory/tool.js";

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  cacheClaudeHeaders(clientRawRequest.headers);

  // Log request endpoint and model
  const url = new URL(request.url);
  const modelStr = body.model;

  // Count messages (support both messages[] and input[] formats)
  const msgCount = body.messages?.length || body.input?.length || 0;
  const toolCount = body.tools?.length || 0;
  const effort = body.reasoning_effort || body.reasoning?.effort || null;

  // Stats & logging
  const _startTime = Date.now();
  const _reqId = log.request({ method: "POST", path: url.pathname, model: modelStr, msgs: msgCount, tools: toolCount, extra: effort ? `effort=${effort}` : null });

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      log.requestError({ id: _reqId, status: HTTP_STATUS.UNAUTHORIZED, error: "Missing API key" });
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      log.requestError({ id: _reqId, status: HTTP_STATUS.UNAUTHORIZED, error: "Invalid API key" });
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    log.requestError({ id: _reqId, status: HTTP_STATUS.BAD_REQUEST, error: "Missing model" });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) {
    const _b = bypassResponse.response || bypassResponse;
    log.requestSummary({ id: _reqId, status: _b.status || 200, duration: Date.now() - _startTime });
    return _b;
  }

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      const _resp = await handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
      log.requestSummary({ id: _reqId, status: _resp.status, duration: Date.now() - _startTime });
      return _resp;
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    const _resp = await handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit
    });
    log.requestSummary({ id: _reqId, status: _resp.status, duration: Date.now() - _startTime });
    return _resp;
  }

  // Single model request
  const _resp = await handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey);
  log.requestSummary({ id: _reqId, status: _resp.status, duration: Date.now() - _startTime });
  return _resp;
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null) {
  // Memory: load + inject persistent memory + extraction hint
  const settings = await getSettings();
  if (settings.memoryEnabled && body.messages) {
    const pool = detectMemoryPool(apiKey);
    log.info("MEMORY", `Request phase pool="${pool}" enabled=true messages=${body.messages.length}`);
    await loadMemoryForRequest(apiKey, body.messages);
    // Inject extraction hint after threshold
    const userMsgCount = body.messages.filter(m => m.role === "user").length;
    log.info("MEMORY", `Extraction threshold check pool="${pool}" userMsgs=${userMsgCount} threshold=${settings.memoryExtractionThreshold}`);
    if (userMsgCount > settings.memoryExtractionThreshold) {
      const extractionState = await loadExtractionState(pool);
      const isFallback = FALLBACK_THRESHOLD > 0
        ? extractionState.consecutiveMisses >= FALLBACK_THRESHOLD
        : false;
      log.info("MEMORY", `Injection pool="${pool}" userMsgs=${userMsgCount} consecutiveMisses=${extractionState.consecutiveMisses} isFallback=${isFallback}`);
      const hintText = getExtractionHint(isFallback);
      if (hintText) {
        const hintMsg = { role: "system", content: hintText };
        const lastSys = body.messages.reduce((last, m, i) => m.role === "system" ? i : last, -1);
        if (lastSys >= 0) {
          body.messages.splice(lastSys + 1, 0, hintMsg);
        } else {
          body.messages.unshift(hintMsg);
        }
      }
    } else {
      log.info("MEMORY", `Skip hint pool="${pool}" userMsgs=${userMsgCount} ≤ threshold=${settings.memoryExtractionThreshold}`);
    }
    // Inject store_memory tool if request has tools (agent-mode conversations)
    if (body.tools && body.tools.length > 0) {
      body.tools.push({ type: "function", function: MEMORY_TOOL_DEFINITION });
      log.info("MEMORY", `Injected store_memory tool pool="${pool}" tools=${body.tools.length}`);
    }
  } else {
    log.info("MEMORY", `Request phase memoryDisabled=${!settings.memoryEnabled} hasMessages=${!!body.messages}`);
  }

  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = settings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = settings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Log model routing (alias → actual model)
  if (modelStr !== `${provider}/${model}`) {
    log.info("ROUTING", `${modelStr} → ${provider}/${model}`);
  } else {
    log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);
  }

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    // Log account selection
    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const providerThinking = (settings.providerThinking || {})[provider] || null;
    const memoryPool = detectMemoryPool(apiKey);
    const result = await handleChatCore({
      onStreamComplete: async (contentObj) => {
        // Memory extraction from streaming response (fire-and-forget)
        if (!settings.memoryEnabled) {
          log.info("MEMORY", `Response phase pool="${memoryPool}" memoryDisabled=true`);
          return;
        }

        // 1. Handle store_memory tool calls (agent mode)
        if (contentObj?.toolCalls?.length > 0) {
          const memoryToolCalls = parseMemoryToolCalls(contentObj.toolCalls);
          if (memoryToolCalls.length > 0) {
            log.info("MEMORY", `TOOL_CALL pool="${memoryPool}" calls=${memoryToolCalls.length} entries=${JSON.stringify(memoryToolCalls)}`);
            const { storeFromToolCalls } = await import("../lib/memory/tool.js");
            storeFromToolCalls(memoryToolCalls, memoryPool).then(result => {
              log.info("MEMORY", `TOOL_STORED pool="${memoryPool}" memory=${result.memoryStored} user=${result.userStored}`);
              recordExtractionAttempt(memoryPool, result.memoryStored || result.userStored).catch(() => {});
            }).catch(err => {
              log.warn("MEMORY", `TOOL_STORE_ERROR pool="${memoryPool}" ${err.message}`);
            });
          }
          return; // Don't double-process prose extraction
        }

        // 2. Handle prose extraction (chat mode) — markers in content
        if (contentObj?.content) {
          log.info("MEMORY", `Response phase pool="${memoryPool}" responseLen=${contentObj.content.length} extracting=true`);
          tryExtractFromResponse(apiKey, contentObj.content).then(extractResult => {
            const stored = extractResult.memoryStored || extractResult.userStored;
            log.info("MEMORY", `Extraction result pool="${memoryPool}" memoryStored=${extractResult.memoryStored} userStored=${extractResult.userStored} attempted=${extractResult.attempted}`);
            recordExtractionAttempt(memoryPool, stored).catch(() => {});
          }).catch(err => {
            log.warn("MEMORY", `Extraction error pool="${memoryPool}" ${err.message}`);
          });
        } else {
          log.info("MEMORY", `Response phase pool="${memoryPool}" noContent noToolCalls`);
        }
      },
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!settings.ccFilterNaming,
      rtkEnabled: !!settings.rtkEnabled,
      cavemanEnabled: !!settings.cavemanEnabled,
      cavemanLevel: settings.cavemanLevel || "full",
      ponytailEnabled: !!settings.ponytailEnabled,
      ponytailLevel: settings.ponytailLevel || "full",
      providerThinking,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      }
    });

    if (result.success) return result.response;

    // Mark account unavailable (auto-calculates cooldown with exponential backoff, or precise resetsAtMs)
    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, result.resetsAtMs);

    if (shouldFallback) {
      log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
