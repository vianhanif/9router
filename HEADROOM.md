# Headroom Token Saver

## Overview

[Headroom](https://github.com/chopratejas/headroom) is a compression proxy for LLM calls that reduces context-token usage before requests reach the provider. It runs as a local sidecar and exposes a `/v1/compress` endpoint that intelligently summarizes conversation history while preserving semantic content.

9router integrates Headroom as a **compression middleware** — not as a transparent MITM proxy hop. The flow is:

```
Client → 9Router → compressWithHeadroom(/v1/compress) → 9Router → provider
```

9router extracts messages from the request body, sends them to Headroom's `/v1/compress` endpoint, receives compressed messages back, and splices them into the body before forwarding to the upstream provider. Normal routing, fallback, auth, and usage tracking continue unaffected.

## Prerequisites

- **Python >= 3.10** (required by `headroom-ai`)
- **Headroom CLI** installed via pip:

```bash
pip install "headroom-ai[proxy]"
```

Optional compression extras:

| Extra | Packages | Effect |
|-------|----------|--------|
| `code` | `tree-sitter`, `tree-sitter-language-pack` | AST-aware code compression |
| `ml` | `torch`, `huggingface-hub` | Kompress-v2 ML model compression |

```bash
pip install "headroom-ai[proxy,code,ml]"
```

The `headroom` CLI binary must be on `PATH`.

## Architecture

### Compression Middleware

9router does **not** route the full request through Headroom as a reverse proxy. Instead:

1. Before the translated request is dispatched to the provider, `compressWithHeadroom()` (in `open-sse/rtk/headroom.js`) runs
2. It extracts the messages array from the request body
3. Sends only the messages to Headroom's `POST /v1/compress` endpoint
4. Receives compressed messages back
5. Splices them back into the request body
6. The request proceeds to the upstream provider with the compressed payload

### Format Translation

The `/v1/compress` endpoint only understands OpenAI-shaped message arrays. For non-OpenAI formats, 9router translates before and after compression:

- **Claude format**: Claude messages → translate to OpenAI → compress → translate back to Claude
- **OpenAI Responses format**: Responses input items → translate to OpenAI messages → compress → translate back to Responses input items
- **Kiro format**: `conversationState.history`/`currentMessage` projected to OpenAI messages → compress → projected back into the original Kiro fields
- **OpenAI format**: messages/input go straight to `/v1/compress`

## Management Framework

9router provides API routes to manage a Headroom sidecar process:

| Route | Method | Description |
|-------|--------|-------------|
| `/api/headroom/start` | POST | Spawns `headroom proxy` with configured options |
| `/api/headroom/stop` | POST | Stops the managed proxy (SIGTERM → SIGKILL after 2s) |
| `/api/headroom/status` | GET | Reports installed, running, Python path, extras status |
| `/api/headroom/restart` | POST | Gracefully restarts the proxy with current settings |
| `/api/headroom/extras` | GET | Lists available extras and installed status; `?log=1` returns install log |
| `/api/headroom/extras` | POST | Installs requested pip extras |
| `/api/headroom/extras` | DELETE | Uninstalls extras |
| `/api/headroom/proxy/[...path]` | GET/POST/etc. | Reverse proxy to Headroom's built-in dashboard |

### Start Details

The proxy is spawned with:

```
headroom proxy --port <port> [--code-aware] [--disable-kompress]
```

- `--code-aware`: enables tree-sitter AST compression (requires `code` extra)
- `--disable-kompress`: disables ML-based Kompress compression (enabled by default)

Default port: `8787`. The process is detached (`spawn` with `detached: true`, `child.unref()`). PID is tracked in `${DATA_DIR}/headroom/proxy.pid`.

### Stop Details

`stopHeadroomProxy()` sends `SIGTERM` to the managed PID. If the process is still alive after 2 seconds, it sends `SIGKILL`.

### Status

`getHeadroomStatus()` aggregates:
- `installed` — whether `headroom` binary is found on PATH
- `path` — path to the headroom binary
- `running` — whether `${url}/health` responds OK (1.5s timeout)
- `python` — Python interpreter path (>= 3.10 that can see `headroom-ai`)
- `localUrl` — whether the URL points to a loopback address
- `canStart` — installed + local URL
- `version` — installed headroom-ai pip package version
- `extras` — which extras are installed (`code`, `ml`)

## Configuration Settings

Settings are read from 9router's settings store (database or env):

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `headroomEnabled` | bool | `false` | Enable Headroom compression |
| `headroomUrl` | string | `http://localhost:8787` | Headroom proxy URL |
| `headroomCompressUserMessages` | bool | `false` | Also compress user (not just assistant) messages |
| `headroomCodeAware` | bool | `false` | Enable tree-sitter AST compression |
| `headroomKompress` | bool | `true` | Enable ML-based Kompress compression |

Env variable: `HEADROOM_URL` overrides the default URL at process level.

## Endpoint Information

Headroom proxy (v0.20.8+) exposes:

| Endpoint | Method | Purpose | Used by 9router |
|----------|--------|---------|-----------------|
| `/v1/compress` | POST | Compress conversation messages | Yes — `compressWithHeadroom()` |
| `/health` | GET | Health check / liveness probe | Yes — `probeProxyRunning()` |
| `/v1/chat/completions` | POST | OpenAI-compatible chat | No — 9router has its own routing |
| `/v1/messages` | POST | Anthropic-compatible messages | No — 9router has its own routing |
| `/v1beta/models/...` | GET | Model listing | No — 9router has its own routing |

The `/v1/compress` endpoint accepts:

```json
{
  "messages": [{"role": "user", "content": "..."}, ...],
  "model": "optional-model-hint",
  "config": {
    "compress_user_messages": true
  }
}
```

And returns:

```json
{
  "messages": [{"role": "user", "content": "..."}, ...]
}
```

The endpoint is loopback-gated — only accessible from `localhost`/`127.0.0.1`.

## Provider Limitations

Headroom's `/v1/compress` only understands OpenAI-shaped message arrays. This means:

- **Supported**: providers using OpenAI, Anthropic/Claude, Gemini, Kiro, and OpenAI Responses formats (all pass through format translation)
- **Not supported**: Custom 9router backends with non-standard path structures (e.g., `opencode-go`, `groq` using incompatible shapes)

9router's format translation layer handles conversion for Claude, OpenAI Responses, and Kiro formats before sending to `/v1/compress`.

## Fail-Open Behavior

**Headroom compression is best-effort.** If Headroom is down, unreachable, or returns an error, 9router silently continues with the original uncompressed request:

- `compressWithHeadroom()` returns `null` on any error (network failure, non-2xx status, missing `messages[]` in response, translation failure)
- The caller in `chatCore.js` logs a warning (`HEADROOM skipped: <reason>`) but does not abort the request
- The original `translatedBody` is left untouched and dispatched to the provider as-is
- This applies to all error categories:
  - Proxy unavailable / connection refused
  - HTTP non-2xx status
  - Missing or malformed response
  - Format translation failure
  - Unexpected exceptions

This is intentional — compression saves tokens when available but must never break a live request.

## Version Requirements

| Component | Minimum Version | Notes |
|-----------|-----------------|-------|
| Headroom proxy | v0.20.8+ | `/v1/compress` endpoint added in this version |
| 9router | v0.5.30+ | First version with production `/v1/compress` integration |
| Python | 3.10+ | Required by `headroom-ai` |

## File Map

| File | Purpose |
|------|---------|
| `open-sse/rtk/headroom.js` | Compression caller: `compressWithHeadroom()`, endpoint builder, format-specific projection |
| `src/lib/headroom/detect.js` | Installation/health detection: `findHeadroomBinary()`, `probeProxyRunning()`, `getHeadroomStatus()` |
| `src/lib/headroom/process.js` | Process lifecycle: `startHeadroomProxy()`, `stopHeadroomProxy()`, `restartHeadroomProxy()`, `installHeadroomExtras()`, `uninstallHeadroomExtras()` |
| `src/app/api/headroom/start/route.js` | API: start proxy |
| `src/app/api/headroom/stop/route.js` | API: stop proxy |
| `src/app/api/headroom/status/route.js` | API: query status |
| `src/app/api/headroom/restart/route.js` | API: restart proxy |
| `src/app/api/headroom/extras/route.js` | API: manage extras |
| `src/app/api/headroom/proxy/[...path]/route.js` | API: reverse proxy to Headroom dashboard |
| `open-sse/handlers/chatCore.js` | Integration point: calls `compressWithHeadroom()` before provider dispatch |
| `src/sse/handlers/chat.js` | Passes `headroomEnabled`/`headroomUrl` from settings to chatCore |
