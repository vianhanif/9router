# 9Router

**FREE AI router & token saver for CLI coding tools.**  
Stop wasting money, tokens, and hitting limits — route across 40+ providers with smart fallback, auto token savings, and zero downtime.

Based on [decolua/9router](https://github.com/decolua/9router) — this fork adds monorepo structure, Hono server (decoupled from Next.js), esbuild CLI bundling, and other enhancements.

> ## 🏗️ Architecture
>
> The API server (port 20128) and dashboard UI (port 20127) run as **separate processes**
> with distinct lifecycles and deployment models:
>
> | Concern | API Server (port 20128) | Dashboard (port 20127) |
> |---------|------------------------|------------------------|
> | **Framework** | Hono (lightweight, 65KB) | Next.js 16 (~300MB with deps) |
> | **Distribution** | Bundled into CLI package via esbuild | Separate deployment (npm run / Docker) |
> | **Startup** | Spawned by `9router` CLI on demand | Started independently |
> | **Size in package** | ~2.5MB single CJS file | Not included (would add ~200MB) |
> | **Required for routing** | ✅ Yes — handles all API requests | ❌ No — only needed for UI |
>
> **Why this separation:**
>
> 1. **CLI package stays lean** — Bundling the Hono server adds ~2.5MB to the npm package.
>    The old Next.js monolith added ~200MB. Smaller package = faster installs, less disk usage,
>    simpler publishing pipeline.
>
> 2. **Zero UI dependency for routing** — The core use case (routing LLM requests, token
>    savings, provider fallback) needs zero browser UI. Users who only need the API endpoint
>    never install Next.js/React. Dashboard-only features (provider management, usage charts,
>    settings) are entirely optional.
>
> 3. **Independent lifecycle** — Each service can be updated, restarted, or scaled without
>    affecting the other. A dashboard deploy doesn't interrupt active LLM requests. A server
>    bug doesn't take down the UI.
>
> 4. **Framework isolation** — The routing engine is decoupled from Next.js. No more
>    Next.js version bumps blocking server updates, or server issues breaking the dashboard.
>    The Hono server can be maintained independently of the dashboard framework.
>
> 5. **Faster development** — `npm run dev:server` starts in ~200ms (no webpack, no React).
>    The dashboard dev server takes ~15s. Separating them means faster iteration on the
>    core routing logic without waiting for the UI to compile.

### Features
- **RTK Token Saver** — Auto-compress `tool_result` content, save 20-40% tokens per request
- **Monthly usage breakdown** — per-provider token/request stats with month picker and export
- **Monthly token/cost chart** — daily time-series area chart for token and cost tracking across billing periods
- **Data management** — retention-based cleanup with preview, summary card, and confirmation modal
- **Combos import/export** — bulk backup/restore model combos with full strategy config
- **Separate LLM API Server & 9router Dashboard** - skip heavy next.js buildup for quick-start serving agent tools

---

## 🔄 How It Works

```
┌─────────────┐
│  Your CLI   │  (Claude Code, Codex, OpenClaw, Cursor, Cline...)
│   Tool      │
└──────┬──────┘
       │ http://localhost:20128/v1
       ↓
┌─────────────────────────────────────────────┐
│           9Router (Smart Router)            │
│  • RTK Token Saver (cut tool_result tokens) │
│  • Format translation (OpenAI ↔ Claude)     │
│  • Quota tracking                           │
│  • Auto token refresh                       │
└──────┬──────────────────────────────────────┘
       │
       ├─→ [Tier 1: SUBSCRIPTION] Claude Code, Codex, GitHub Copilot
       │   ↓ quota exhausted
       ├─→ [Tier 2: CHEAP] GLM ($0.6/1M), MiniMax ($0.2/1M)
       │   ↓ budget limit
       └─→ [Tier 3: FREE] Kiro, OpenCode Free, Vertex ($300 credits)

Result: Never stop coding, minimal cost + 20-40% token savings via RTK
```

---

## ⚡ Quick Start

**1. Clone and set up:**

```bash
git clone git@github.com:vianhanif/9router.git
cd 9router
npm install
cd cli && npm run build && cd ..
```

**2. Start the server:**

```bash
node cli/cli.js
```

API available at `http://localhost:20128/v1`

**3. Connect a FREE provider (no signup needed):**

Open the dashboard at `http://localhost:20127` → Providers → Connect **Kiro AI** (free Claude unlimited) or **OpenCode Free** (no auth) → Done!

**4. Use in your CLI tool:**

```
Claude Code/Codex/OpenClaw/Cursor/Cline Settings:
  Endpoint: http://localhost:20128/v1
  API Key: [copy from dashboard]
  Model: kr/claude-sonnet-4.5
```

**That's it!** Start coding with FREE AI models.

**Pro tip — development mode:** After cloning, run from workspace source without building:

```bash
npm run dev:server      # starts server on port 20128 (~200ms)
npm run dev:dashboard   # starts dashboard on port 20127 (optional, ~15s)
```

### Available Commands

**Shell aliases** (add to `~/.zshrc` or `~/.config/zsh/aliases`):

```bash
export NINEROUTER_HOME="$HOME/path/to/9router"

# Server (production) — start the bundled server directly
alias 9r-start='node "$NINEROUTER_HOME/cli/app/server.js"'

# CLI (production) — menu interface using bundled server
alias 9r-cli='node "$NINEROUTER_HOME/cli/cli.js"'

# CLI (dev) — menu interface using source server (no build needed)
alias 9r-dev='cd "$NINEROUTER_HOME" && 9ROUTER_DEV=1 node cli/cli.js'

# Server (dev) — raw Hono server from source, no CLI menu
alias 9r-serve='cd "$NINEROUTER_HOME/apps/server" && node src/index.js'

# Build CLI — esbuild bundle server → cli/app/server.js
alias 9r-build='cd "$NINEROUTER_HOME/cli" && npm run build'

# Dashboard (production) — build + start dashboard on port 20127
alias 9r-dash='cd "$NINEROUTER_HOME" && npm run build -w apps/dashboard && npm run start -w apps/dashboard'

# Dashboard (dev) — hot-reload dev server on port 20127
alias 9r-dash-dev='cd "$NINEROUTER_HOME" && npm run dev -w apps/dashboard'

# Health check
alias 9r-health='curl -s http://localhost:20128/health | python3 -m json.tool'
```

Default URLs:
- Dashboard: `http://localhost:20127`
- OpenAI-compatible API: `http://localhost:20128/v1`

---

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.

---

<div align="center">
  <sub>Built with ❤️ for developers who code 24/7</sub>
</div>
