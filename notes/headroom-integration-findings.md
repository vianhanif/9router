# Headroom Integration — Autopsy

## What was attempted

9Router had code to call headroom's `/v1/compress` endpoint to compress LLM request messages before sending to providers, with the goal of reducing token usage and saving costs (especially for opencode-go credits).

The integration path:
```
chat.js -> chatCore.js -> rtk/headroom.js -> HTTP POST localhost:8787/v1/compress
```

## Why it never worked

### Root cause: wrong API

Headroom v0.5.4 proxy **does not expose a `/v1/compress` endpoint**. The proxy works as a transparent MITM:
- `/v1/chat/completions` -> intercepts -> compresses -> forwards to OpenAI API
- `/v1/messages` -> intercepts -> compresses -> forwards to Anthropic API
- `/v1beta/models/{model}:generateContent` -> intercepts -> compresses -> forwards to Gemini API

There is no standalone compression-as-a-service endpoint.

Every `compressWithHeadroom()` call returned a silent 404 -> null -> no compression, no logs.

### Option E (proxy route) doesn't work either

8Router providers use custom API paths:

| Provider | API URL | Matches headroom? |
|----------|---------|--------------------|
| opencode-go | `/zen/go/v1/chat/completions` | No |
| groq | `/openai/v1/chat/completions` | No |
| cerebras | `/v1/chat/completions` | Path matches but forwards to OpenAI, not cerebras |

Even for matching paths, headroom hard-forwards to OpenAI/Anthropic/Gemini, not to custom providers.

### Option D (microserver) doable but heavy

`headroom.compress()` uses HuggingFace transformers/LLMLingua for ML-powered compression. These deps aren't in the pipx venv. Installing requires:
- `transformers` (~500MB)
- `torch` (~2GB)
- `sentencepiece`, `tokenizers`, etc.

Without these, even basic token counting fails.

## What actually works

**RTK compression** (`packages/core/rtk/index.js`) is already enabled and functional. It compresses tool message content in-line:
- OpenAI tool message content (string and array shapes)
- Claude tool result blocks
- OpenAI Responses tool output
- Kiro format tool output

Zero external dependencies, no network calls.

## Files removed

| File | Reason |
|------|--------|
| `apps/server/src/services/headroom.js` | Entire service - dead code |
| `apps/server/src/routes/headroom.js` | Entire route - dead code |
| `packages/core/rtk/headroom.js` | `compressWithHeadroom` + `formatHeadroomLog` - no longer imported |

## Files modified

| File | Change |
|------|--------|
| `apps/server/src/app.js` | Removed headroomRouter import and `/api/headroom` route |
| `apps/server/src/handlers/chat.js` | Removed headroom params passed to `handleChatCore` |
| `packages/core/handlers/chatCore.js` | Removed `compressWithHeadroom` call and headroom params |
| `apps/server/src/routes/status.js` | Removed headroom from tokenSavers response |

## Headroom proxy still useful outside 9Router

The `headroom proxy` (separate Python process on port 8787) works for direct client usage:
```bash
ANTHROPIC_BASE_URL=http://localhost:8787 claude
OPENAI_BASE_URL=http://localhost:8787/v1 your-app
```

But for 9Router's routing pipeline, it contributed nothing.
