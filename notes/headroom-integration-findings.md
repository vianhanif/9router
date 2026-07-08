# Headroom Integration — Autopsy

## What was attempted

9Router had code to call headroom's `/v1/compress` endpoint to compress LLM request messages before sending to providers, with the goal of reducing token usage and saving costs (especially for opencode-go credits).

The integration path:
```
chat.js → chatCore.js → rtk/headroom.js → HTTP POST localhost:8787/v1/compress
```

## Why it never worked

### Root cause: wrong API

Headroom v0.5.4 proxy **does not expose a `/v1/compress` endpoint**. The proxy works as a transparent MITM with hard-coded routes only:

| Route | Forwards to |
|-------|-------------|
| `/v1/chat/completions` | OpenAI API |
| `/v1/messages` | Anthropic API |
| `/v1beta/models/{model}:generateContent` | Gemini API |

There is no standalone compression-as-a-service endpoint. Every `compressWithHeadroom()` call silently hit a 404 → returned null → no compression, no error logs visible to the user.

### Option E (proxy route) — incompatible with 9Router providers

9Router's providers use custom API paths that don't match headroom's explicit routes:

| Provider | API URL | Matches headroom? |
|----------|---------|-------------------|
| opencode-go | `/zen/go/v1/chat/completions` | No |
| groq | `/openai/v1/chat/completions` | No |
| cerebras | `/v1/chat/completions` | Path matches but forwards to OpenAI, not cerebras |

Even when the path matched, headroom hard-forwards to OpenAI/Anthropic/Gemini — not to 9Router's custom provider backends.

### Option D (microserver) — heavy and unverified

`headroom.compress()` uses HuggingFace transformers / LLMLingua for ML-powered compression. These deps aren't in the pipx venv. Installing requires:

- `transformers` (~500MB)
- `torch` (~2GB)
- `sentencepiece`, `tokenizers`, etc.

Without these, even basic token counting fails. The Python `compress()` function was tested directly and confirmed to error without transformers. Installing ~2.5GB of ML dependencies for one feature that only helps a narrow set of providers is disproportionate.

### Fatal error: silent 404 loop

```
compressWithHeadroom() → HTTP POST localhost:8787/v1/compress → 404
→ null → formatHeadroomLog(null) → null → no log line
```

Every request triggered a silent failure. No compression, no errors surfaced to the user.

## What actually works

**RTK compression** (`packages/core/rtk/index.js`) is already enabled and functional. It compresses tool message content in-line — no ML models, no network calls, zero extra latency:

- OpenAI tool message content (string and array shapes)
- Claude tool result blocks
- OpenAI Responses tool output
- Kiro format tool output

## Options evaluated

| Option | Description | Verdict |
|--------|-------------|---------|
| A: Keep as-is | `compressWithHeadroom()` always 404s silently | ❌ No-op |
| B: Fix URL | No `/v1/compress` endpoint exists in headroom proxy | ❌ Not possible |
| C: Fork headroom | Add custom `/v1/compress` route to fork | ❌ Scope creep |
| D: Microserver | Spin up Python FastAPI microserver with transformers + torch | ❌ ~2.5GB deps, heavy infra |
| E: Proxy route | Route provider requests through headroom proxy | ❌ Only OpenAI/Anthropic/Gemini, not custom providers |
| **F: Remove** | Delete dead headroom code, document findings, rely on RTK | ✅ Done |

## Files removed

| File | Lines removed |
|------|--------------|
| `apps/server/src/services/headroom.js` | Entire service |
| `apps/server/src/routes/headroom.js` | Entire route |
| `packages/core/rtk/headroom.js` | `compressWithHeadroom` + `formatHeadroomLog` |

## Files modified

| File | Change |
|------|--------|
| `apps/server/src/app.js` | Removed `headroomRouter` import and `/api/headroom` route |
| `apps/server/src/handlers/chat.js` | Removed headroom params passed to `handleChatCore` |
| `packages/core/handlers/chatCore.js` | Removed `compressWithHeadroom` call and headroom params |
| `apps/server/src/routes/status.js` | Removed headroom from `tokenSavers` response |
| `apps/dashboard/src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.js` | Replaced status badge + Manage/Setup button with deprecation label; updated description |

## Dashboard UI status

The "Compress context (Headroom)" toggle remains in the Token Saver section but is **inactive**. The label now reads:

```
Compress context (Headroom) (inactive — proxy not used by 9Router)
```

The description explains: _"Headroom proxy only compresses for OpenAI/Anthropic/Gemini clients routed through it — 9Router sends requests directly to providers. See notes/headroom-integration-findings.md."_

The install modal (`Headroom Install Guide Modal`) still exists in the UI but its backend endpoints (`/api/headroom/status`, `/api/headroom/start`, `/api/headroom/stop`) no longer exist — clicking through will 404. Gutting the dead state/handlers/modal is a low-priority cleanup.

## Headroom proxy still useful outside 9Router

The headroom proxy (separate Python process on port 8787) works for direct CLI/SDK usage:

```bash
ANTHROPIC_BASE_URL=http://localhost:8787 claude
OPENAI_BASE_URL=http://localhost:8787/v1 your-app
```

But for 9Router's routing pipeline — where requests go directly to custom provider backends — it contributed nothing.

## Commits

- `9d55183` — feat(server): auto-enable compress on headroom start; fix status/summary headroom fields; add --json/--status CLI flags (pre-removal, last state before evaluation)
- `fbc3099` — remove dead headroom integration + add note
- `0e6d8ba` — dashboard: mark headroom as inactive in Token Saver UI
