### Task Overview

**What:** Restructure the monolithic Next.js 9router app into a monorepo with two independently runnable apps (dashboard + server) and shared packages.

**Why:** The LLM router API (`/v1/*`) currently lives inside Next.js as API routes, coupling the data-plane (LLM request execution) to the control-plane (dashboard UI). This forces the entire Next.js stack onto the LLM server, bloating it with React/Tailwind deps. Users who only want the LLM API shouldn't need Next.js. Separating them enables:
- Independent scaling (server can run on lightweight infra)
- Independent deployment (update dashboard without touching server)
- Clear separation of concerns (dashboard = config authority, server = execution engine)

**Success Criteria:**
- `apps/server` runs standalone with `node src/index.js` (no Next.js, no React, no browser deps)
- `apps/dashboard` runs as a Next.js app with all existing UI + CRUD API routes
- Both apps share the same SQLite DB file (config written by dashboard, read by server)
- All existing `/v1/*` endpoints work identically (OpenAI-compatible chat, models, embeddings, images, audio, search)
- All existing dashboard features (provider management, keys, combos, usage, settings) work identically
- CLI (`cli/`) can launch the server app standalone
- `npm run dev:dashboard` (port 20127) and `npm run dev:server` (port 20128) work in separate terminals
- **Clients connect directly to server port for LLM API** — no proxy needed from dashboard. Two separate ports, direct connection.
- No breaking changes for existing users

---

### Current Architecture (Baseline)

```
9router/                          # name: "9router-app" v0.5.8
├── package.json                  # Next.js app (single package)
├── next.config.mjs               # rewrites: /v1/* → /api/v1/*
├── custom-server.js              # wraps .next/standalone/server.js
├── Dockerfile
├── jsconfig.json                 # paths: @/* → ./src/*, open-sse/* → ./open-sse/*
├── open-sse/                     # Core LLM routing engine (NOT a package, just a dir)
├── cli/                          # npm package "9router" (separate, published)
├── src/
│   ├── app/
│   │   ├── (dashboard)/          # Dashboard UI (88 files)
│   │   ├── api/
│   │   │   ├── v1/               # LLM Router API (NEEDS TO MOVE)
│   │   │   ├── v1beta/           # Beta endpoints (NEEDS TO MOVE)
│   │   │   ├── auth/             # Dashboard auth (STAYS)
│   │   │   ├── providers/        # Provider CRUD (STAYS)
│   │   │   ├── keys/             # API key mgmt (STAYS)
│   │   │   ├── usage/            # Usage tracking (STAYS)
│   │   │   ├── combos/           # Combo config (STAYS)
│   │   │   ├── settings/         # Settings (STAYS)
│   │   │   ├── mcp/              # MCP tools (STAYS)
│   │   │   ├── oauth/            # OAuth flow (STAYS)
│   │   │   └── 15+ more          # All stay in dashboard
│   │   ├── login/                # Login page (STAYS)
│   │   ├── landing/              # Marketing page (STAYS)
│   │   └── layout.js             # Root layout (STAYS)
│   ├── sse/                      # Handler glue (11 files → MOVE TO server)
│   ├── lib/
│   │   ├── db/                   # DB layer (→ packages/db)
│   │   ├── auth/                 # Dashboard JWT (STAYS in dashboard)
│   │   ├── headroom/             # Compress proxy (STAYS in dashboard)
│   │   ├── network/              # Proxy config (STAYS in dashboard)
│   │   ├── mcp/                  # MCP (STAYS in dashboard)
│   │   ├── oauth/                # OAuth (STAYS in dashboard)
│   │   ├── tunnel/               # Tunnel (STAYS in dashboard)
│   │   └── ...
│   └── shared/
│       ├── components/           # React components (46 files → STAYS in dashboard)
│       ├── constants/            # Provider/model defs (→ packages/shared)
│       ├── hooks/                # React hooks (STAYS in dashboard)
│       ├── services/             # Bootstrap/init (STAYS in dashboard)
│       └── utils/                # machineId, ssrfGuard, etc (selectively → shared pkg)
├── tests/                        # vitest test suite
└── changelog/
```

**Import path resolution (current):**
- `@/lib/localDb` → `./src/lib/localDb` (re-exports from `./src/lib/db/index.js`)
- `@/shared/constants/providers` → `./src/shared/constants/providers.js`
- `open-sse/handlers/chatCore.js` → `./open-sse/handlers/chatCore.js`
- `@/sse/handlers/chat.js` → `./src/sse/handlers/chat.js`

**Key finding from codebase exploration:**
- `open-sse/` has ZERO imports from `@/lib` or `@/shared` — it is self-contained and can become a package with NO code changes
- `src/sse/` handlers import from both `@/lib/localDb` and `@/shared/constants` — these are the bridge layer
- The v1 API routes (11 route files) all delegate to `src/sse/handlers/*` via `@/sse/handlers/*` imports

---

### Target Architecture (Monorepo)

```
9router/                          # Root: workspace orchestrator (no deps)
├── package.json                  # Workspaces: ["apps/*", "packages/*"]
├── .gitignore                    # +.worktrees/
├── changelog/
├── tests/                        # Integration tests (shared across apps)
│
├── apps/
│   ├── dashboard/                # Next.js dashboard (control plane)
│   │   ├── package.json          # name: "9router-dashboard"
│   │   ├── next.config.mjs
│   │   ├── custom-server.js
│   │   ├── Dockerfile
│   │   ├── jsconfig.json         # paths: @/* → ./src/*
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── (dashboard)/  # Dashboard UI pages (88 files, UNCHANGED)
│   │   │   │   ├── api/          # Dashboard CRUD routes ONLY (no v1/)
│   │   │   │   ├── login/
│   │   │   │   ├── landing/
│   │   │   │   └── layout.js + globals.css
│   │   │   ├── lib/              # Dashboard-specific lib (oauth, headroom, network, mcp, tunnel, etc.)
│   │   │   ├── shared/           # React components, hooks (dashboard-specific)
│   │   │   └── ...
│   │   └── public/
│   │
│   ├── server/                   # Standalone LLM API server (data plane)
│   │   ├── package.json          # name: "9router-server" — NO next/react/tailwind
│   │   ├── Dockerfile            # Lightweight (no Next build needed)
│   │   ├── src/
│   │   │   ├── index.js          # Entry point: starts HTTP server
│   │   │   ├── app.js            # Hono app setup, middleware, route mounting
│   │   │   ├── routes/
│   │   │   │   ├── v1/
│   │   │   │   │   ├── chat/completions.js     # from src/app/api/v1/chat/completions/route.js
│   │   │   │   │   ├── models.js                # from src/app/api/v1/models/route.js
│   │   │   │   │   ├── models/[kind]/route.js  # from src/app/api/v1/models/[kind]/route.js
│   │   │   │   │   ├── models/info/route.js    # from src/app/api/v1/models/info/route.js
│   │   │   │   │   ├── embeddings.js           # from src/app/api/v1/embeddings/route.js
│   │   │   │   │   ├── images/generations.js   # from src/app/api/v1/images/generations/route.js
│   │   │   │   │   ├── audio/speech.js         # from src/app/api/v1/audio/speech/route.js
│   │   │   │   │   ├── audio/transcriptions.js # from src/app/api/v1/audio/transcriptions/route.js
│   │   │   │   │   ├── audio/voices.js         # from src/app/api/v1/audio/voices/route.js
│   │   │   │   │   ├── search.js               # from src/app/api/v1/search/route.js
│   │   │   │   │   ├── web/fetch.js            # from src/app/api/v1/web/fetch/route.js
│   │   │   │   │   ├── messages.js             # from src/app/api/v1/messages/route.js
│   │   │   │   │   ├── responses.js            # from src/app/api/v1/responses/route.js
│   │   │   │   │   ├── responses/compact.js    # from src/app/api/v1/responses/compact/route.js
│   │   │   │   │   ├── api/chat.js             # from src/app/api/v1/api/chat/route.js
│   │   │   │   │   └── route.js                # from src/app/api/v1/route.js
│   │   │   │   └── health.js                   # from src/app/api/health/route.js
│   │   │   ├── middleware/
│   │   │   │   ├── auth.js         # API key validation (extracted from src/sse/services/auth.js)
│   │   │   │   └── cors.js         # CORS headers (moved from route files)
│   │   │   ├── handlers/           # Moved from src/sse/handlers/
│   │   │   │   ├── chat.js
│   │   │   │   ├── embeddings.js
│   │   │   │   ├── imageGeneration.js
│   │   │   │   ├── tts.js
│   │   │   │   ├── stt.js
│   │   │   │   ├── search.js
│   │   │   │   └── fetch.js
│   │   │   ├── services/           # Moved from src/sse/services/
│   │   │   │   ├── auth.js
│   │   │   │   ├── model.js
│   │   │   │   └── tokenRefresh.js
│   │   │   └── utils/              # Moved from src/sse/utils/
│   │   │       └── logger.js
│   │   └── config.js               # Port, DB path, env vars
│   │
│   └── cli/                        # STAYS (already separate npm package)
│       └── ...                     # Minor updates: point to apps/server instead of .next/standalone
│
├── packages/
│   ├── core/                       # from root open-sse/ (NO code changes)
│   │   ├── package.json            # name: "@9router/core"
│   │   ├── index.js                # same barrel exports
│   │   ├── config/
│   │   ├── executors/              # 23 provider executors
│   │   ├── providers/              # registry (96 providers), capabilities, pricing
│   │   ├── handlers/               # chatCore, embeddingsCore, imageGenerationCore, etc.
│   │   ├── translator/             # format conversion pipeline
│   │   ├── services/               # combo, model, tokenRefresh, accountFallback, projectId
│   │   ├── transformer/            # responsesTransformer, streamToJsonConverter
│   │   ├── shared/                 # clineAuth, machineId, qoder
│   │   ├── rtk/                    # Request token-killer
│   │   └── utils/                  # streams, error handling, proxy, session management
│   │
│   ├── db/                         # from src/lib/db/ (NO code changes)
│   │   ├── package.json            # name: "@9router/db"
│   │   ├── src/
│   │   │   ├── index.js            # barrel exports (same as current)
│   │   │   ├── driver.js           # adapter selection logic
│   │   │   ├── adapters/           # bunSqlite, betterSqlite, nodeSqlite, sql.js
│   │   │   ├── repos/              # settings, connections, nodes, proxyPools, apiKeys, combos, alias, pricing, disabledModels, usage, requestDetails
│   │   │   ├── migrations/         # schema migration files
│   │   │   ├── helpers/
│   │   │   ├── schema.js
│   │   │   ├── paths.js
│   │   │   ├── backup.js
│   │   │   └── migrate.js
│   │   └── ...
│   │
│   ├── shared/                     # Shared constants + utils (from src/shared/constants/ + selective utils)
│   │   ├── package.json            # name: "@9router/shared"
│   │   └── src/
│   │       ├── index.js            # barrel exports
│   │       ├── constants/
│   │       │   ├── providers.js    # AI_PROVIDERS, resolveProviderId, FREE_PROVIDERS
│   │       │   ├── models.js       # PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS, getModelKind
│   │       │   ├── config.js       # APIKEY_PROVIDERS, etc.
│   │       │   ├── colors.js
│   │       │   ├── locales.js
│   │       │   └── index.js
│   │       └── utils/
│   │           ├── machineId.js    # getConsistentMachineId
│   │           ├── ssrfGuard.js    # assertPublicUrl
│   │           └── index.js
│   │
│   └── types/                      # (optional) Shared JSDoc types if needed
│       └── package.json            # name: "@9router/types"
│
├── tests/                          # Updated to test shared packages
├── docker/
│   ├── dashboard.Dockerfile
│   └── server.Dockerfile
└── scripts/
    └── dev.sh                      # Utility: start both apps
```

---

### Scope Table

| # | Scope | Target Branch | Repository | Complexity | Estimate |
|---|-------|--------------|------------|------------|----------|
| 0 | **Workspace skeleton** — root `package.json` (workspaces), top-level dirs, `.gitignore` update | `master` | 9router | Low | ~30 min |
| 1 | **`packages/core`** — move `open-sse/` → `packages/core/`, add `package.json`, update root imports | `master` | 9router | Medium | ~1 hr |
| 2 | **`packages/db`** — move `src/lib/db/` → `packages/db/`, add `package.json`, update consumers | `master` | 9router | Medium | ~1 hr |
| 3 | **`packages/shared`** — move `src/shared/constants/` + selective utils, add `package.json` | `master` | 9router | Medium | ~1 hr |
| 4 | **`apps/server`** — create standalone HTTP server with v1 routes + SSE handlers | `master` | 9router | High | ~2-3 hrs |
| 5 | **`apps/dashboard`** — slim down Next.js app (remove v1 routes, rewire imports to packages) | `master` | 9router | High | ~2 hrs |
| 6 | **CLI update** — point `cli/` to launch server app instead of Next.js standalone | `master` | 9router | Medium | ~1 hr |
| 7 | **Docker + CI/CD** — update Dockerfiles, CI pipelines, docs | `master` | 9router | Medium | ~1 hr |

---

### Phase 0: Workspace Skeleton

**What:** Create the monorepo workspace structure at root level. No code moves yet.

**Files to create:**
```
9router/
├── package.json              # REWRITE — change to workspace root
├── apps/dashboard/           # Skeleton (placeholder)
├── apps/server/              # Skeleton (placeholder)
├── packages/core/            # Symlink to open-sse/ initially? No — use npm workspace
├── packages/db/              # Skeleton
└── packages/shared/          # Skeleton
```

**Root `package.json` changes:**
```json
{
  "name": "9router-monorepo",
  "private": true,
  "version": "0.5.8",
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "dev:dashboard": "npm run dev -w apps/dashboard",
    "dev:server": "npm run dev -w apps/server",
    "build:dashboard": "npm run build -w apps/dashboard",
    "build:server": "npm run build -w apps/server",
    "build:packages": "npm run build -w packages/core -w packages/db -w packages/shared",
    "build": "npm run build:packages && npm run build:dashboard && npm run build:server"
  }
}
```

**Key decisions:**
- npm workspaces (not pnpm/yarn) — keeps tooling consistent with existing npm usage
- `apps/*` and `packages/*` glob pattern — flat structure, easy to add more
- Root `package.json` becomes orchestrator only (no dependencies)
- All deps move to individual app/package `package.json` files

**Files to modify:**
- `/package.json` — rewrite as workspace root
- `/.gitignore` — add `.worktrees/` 
- `/.npmignore` — remove (not publishing root)

**Verification:**
- `npm install` at root links all workspace packages
- `npm ls` shows workspace structure

---

### Phase 1: `packages/core` (open-sse → @9router/core)

**What:** Move the entire `open-sse/` directory to `packages/core/` with minimal changes.

**Files to create:**
```
packages/core/package.json
```

**`packages/core/package.json`:**
```json
{
  "name": "@9router/core",
  "version": "0.5.8",
  "type": "module",
  "main": "./index.js",
  "exports": {
    ".": "./index.js",
    "./*": "./*"
  },
  "dependencies": {
    "undici": "^7.19.2",
    "socks-proxy-agent": "^8.0.5",
    "uuid": "^13.0.0",
    "confbox": "^0.2.4"
  }
}
```

**No changes to open-sse/ source code** — the `open-sse/*` import alias in the root `jsconfig.json` already resolves to this directory. Once it moves to `packages/core/`, the workspace resolution makes `@9router/core/*` available.

**Files to move (git mv for blame preservation):**
```bash
mkdir -p packages/core
git mv open-sse/* packages/core/
git mv open-sse/.* packages/core/ 2>/dev/null || true  # dotfiles
# Copy package.json into packages/core/
cp packages/core/package.json.template packages/core/package.json || true
```

**Files to update (import paths):**
The current `jsconfig.json` has:
```json
{
  "paths": {
    "open-sse": ["./open-sse"],
    "open-sse/*": ["./open-sse/*"]
  }
}
```
After the move, any file that imports from `open-sse/*` needs to change to:
- `@9router/core` (for index barrel)
- `@9router/core/handlers/chatCore.js` (for specific modules)

**Files that import from open-sse (53 matches across codebase):**
Using the grep results, every `import ... from "open-sse/..."` must become `import ... from "@9router/core/..."`.

**Backward compat:** Keep the jsconfig paths working during transition by adding:
```json
"@9router/core": ["./packages/core"],
"@9router/core/*": ["./packages/core/*"]
```
This way both old (`open-sse/*`) and new (`@9router/core/*`) imports work simultaneously.

**No code changes to `open-sse/` files.** The 2 tokenRefresh edge cases that import from `../../../src/lib/oauth/` should be refactored (extract credential constants into a separate file in core, or pass them as config).

**Verification:**
- `npm install -w packages/core` installs core deps
- Import `@9router/core` from a test file resolves correctly

---

### Phase 2: `packages/db` (@9router/db)

**What:** Extract `src/lib/db/` into its own package. This is the database layer used by both apps.

**Files to create:**
```
packages/db/package.json
```

**`packages/db/package.json`:**
```json
{
  "name": "@9router/db",
  "version": "0.5.8",
  "type": "module",
  "main": "./src/index.js",
  "exports": {
    ".": "./src/index.js",
    "./*": "./src/*"
  },
  "dependencies": {
    "better-sqlite3": "^12.6.2",
    "sql.js": "^1.14.1"
  },
  "optionalDependencies": {
    "better-sqlite3": "^12.6.2"
  }
}
```

**Files to move (from `src/lib/db/` → `packages/db/src/`):**
```
src/lib/db/index.js          → packages/db/src/index.js
src/lib/db/driver.js         → packages/db/src/driver.js
src/lib/db/schema.js         → packages/db/src/schema.js
src/lib/db/migrate.js        → packages/db/src/migrate.js
src/lib/db/paths.js          → packages/db/src/paths.js
src/lib/db/backup.js         → packages/db/src/backup.js
src/lib/db/version.js        → packages/db/src/version.js
src/lib/db/helpers/          → packages/db/src/helpers/
src/lib/db/adapters/         → packages/db/src/adapters/
src/lib/db/repos/            → packages/db/src/repos/
src/lib/db/migrations/       → packages/db/src/migrations/
```

**No code changes to the DB files** — the package just wraps them with a package.json. All internal imports use relative paths already.

**Backward compat shim:** Keep `src/lib/localDb.js` as a re-export shim for the dashboard during transition:
```js
// src/lib/localDb.js — kept for backward compat during transition
export * from "@9router/db";
```

**Files that import from `@/lib/localDb` or `@/lib/db`:** These all need to change to `@9router/db`. This affects:
- `src/sse/` handlers (7 files) — will move to `apps/server/` in Phase 4
- Dashboard API routes (20+ files) — stay in dashboard, can use `@9router/db` directly
- Dashboard lib files (various) — stay, can use `@9router/db`

**Strategy:** Do NOT bulk-rewrite all files in this phase. Instead:
1. Create the package
2. Update the jsconfig paths to add `@9router/db` mapping
3. Gradually update imports as each file is touched in later phases

**Verification:**
- `npm install -w packages/db` installs DB deps
- Import `@9router/db` resolves correctly
- `getAdapter()` initializes SQLite

---

### Phase 3: `packages/shared` (@9router/shared)

**What:** Extract shared constants and utilities that both apps need.

**Files to create:**
```
packages/shared/package.json
```

**`packages/shared/package.json`:**
```json
{
  "name": "@9router/shared",
  "version": "0.5.8",
  "type": "module",
  "main": "./src/index.js",
  "exports": {
    ".": "./src/index.js",
    "./constants/*": "./src/constants/*",
    "./utils/*": "./src/utils/*"
  }
}
```

**Files to move (from `src/shared/` → `packages/shared/src/`):**
```
src/shared/constants/index.js     → packages/shared/src/constants/index.js
src/shared/constants/providers.js → packages/shared/src/constants/providers.js
src/shared/constants/models.js    → packages/shared/src/constants/models.js
src/shared/constants/config.js    → packages/shared/src/constants/config.js
src/shared/constants/colors.js    → packages/shared/src/constants/colors.js
src/shared/constants/locales.js   → packages/shared/src/constants/locales.js
src/shared/constants/ttsProviders.js  → packages/shared/src/constants/ttsProviders.js
src/shared/constants/mitmToolHosts.js → packages/shared/src/constants/mitmToolHosts.js
src/shared/constants/skills.js    → packages/shared/src/constants/skills.js
src/shared/constants/coworkPlugins.js → packages/shared/src/constants/coworkPlugins.js
```

**Selective utils to move:**
```
src/shared/utils/machineId.js     → packages/shared/src/utils/machineId.js
src/shared/utils/ssrfGuard.js     → packages/shared/src/utils/ssrfGuard.js
src/shared/utils/cn.js            → packages/shared/src/utils/cn.js
src/shared/utils/index.js         → packages/shared/src/utils/index.js
```

**What STAYS in `apps/dashboard/src/shared/`:**
- `components/` (46 files — React components are dashboard-only)
- `hooks/` (4 files — React hooks are dashboard-only)
- `services/` (3 files — dashboard bootstrap)
- `utils/providerModelsFetcher.js` (dashboard-specific)
- `utils/api.js` (dashboard API client)
- `utils/connectionStatus.js` (dashboard-specific)
- `utils/apiKey.js` (dashboard-specific)
- `utils/providerCustomModels.js` (dashboard-specific)
- `utils/clineAuth.js` (dashboard-specific)

**IMPORTANT:** The `src/shared/` directory will be SPLIT. The constants/utils that move to the package will be removed from `src/shared/`. The remaining files (components, hooks, services, dashboard-specific utils) stay in `apps/dashboard/src/shared/`.

**Verification:**
- `npm install -w packages/shared` installs (no deps)
- Import `@9router/shared/constants/providers` resolves correctly

---

### Phase 4: `apps/server` (Standalone LLM Server)

**What:** Create the standalone server app. This is the most complex phase.

**HTTP framework choice:** Use **Hono** — natively supports standard `Request`/`Response` objects, so the `src/sse/handlers/chat.js` and other handler functions work directly without any bridge layer. Lighter than Express, built-in streaming support, no adapter needed. The custom-server.js Express wrapper stays with the dashboard only (dashboard uses standalone Next.js output + Express).

**Why not Next.js standalone:** The whole point is to remove Next.js. The server needs:
- HTTP server (Express or Node built-in)
- CORS middleware
- Auth middleware (API key validation)
- Route handlers (delegate to sse handlers → open-sse core)
- No React, no Tailwind, no Next.js

**Files to create:**
```
apps/server/package.json
apps/server/src/index.js
apps/server/src/app.js
apps/server/src/config.js
apps/server/src/routes/v1/index.js             # Route aggregator
apps/server/src/routes/v1/chat/completions.js
apps/server/src/routes/v1/models.js
apps/server/src/routes/v1/embeddings.js
apps/server/src/routes/v1/images/generations.js
apps/server/src/routes/v1/audio/speech.js
apps/server/src/routes/v1/audio/transcriptions.js
apps/server/src/routes/v1/audio/voices.js
apps/server/src/routes/v1/search.js
apps/server/src/routes/v1/web/fetch.js
apps/server/src/routes/v1/messages.js
apps/server/src/routes/v1/responses.js
apps/server/src/routes/v1/responses/compact.js
apps/server/src/routes/v1/api/chat.js
apps/server/src/routes/health.js
apps/server/src/middleware/auth.js
apps/server/src/middleware/cors.js
apps/server/Dockerfile
```

**`apps/server/package.json`:**
```json
{
  "name": "9router-server",
  "version": "0.5.8",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "node --watch src/index.js",
    "start": "NODE_ENV=production node src/index.js",
    "build": "echo 'Server is plain JS — no build needed'"
  },
  "dependencies": {
    "hono": "^4.x",
    "@9router/core": "*",
    "@9router/db": "*",
    "@9router/shared": "*",
    "jose": "^6.1.3",
    "bcryptjs": "^3.0.3",
    "undici": "^7.19.2",
    "uuid": "^13.0.0"
  }
}
```

**`apps/server/src/config.js`:** Server config (port, DB path, env vars):
```js
export const PORT = process.env.PORT || 20128;
export const HOST = process.env.HOSTNAME || "0.0.0.0";
export const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), ".9router");
export const DB_PATH = path.join(DATA_DIR, "data.db");
```

**`apps/server/src/index.js`:** Entry point:
```js
import { initDb } from "@9router/db";
import { initTranslators } from "@9router/core/translator/index.js";
import { createApp } from "./app.js";
import { PORT, HOST } from "./config.js";

async function main() {
  await initDb();                    // Initialize DB + run migrations
  await initTranslators();           // Initialize translator pipeline
  const app = createApp();
  app.listen(PORT, HOST, () => {
    console.log(`9router-server listening on ${HOST}:${PORT}`);
  });
}
main().catch(console.error);
```

**`apps/server/src/app.js`:** Hono app setup — no bridge needed, handlers work directly:
```js
import { Hono } from "hono";
import { cors } from "hono/cors";
import { authMiddleware } from "./middleware/auth.js";
import { v1Router } from "./routes/v1/index.js";
import { healthRouter } from "./routes/health.js";

export function createApp() {
  const app = new Hono();
  
  // Global middleware
  app.use("*", cors());
  app.use("/v1/*", authMiddleware);
  
  // Routes
  app.route("/v1", v1Router);
  app.route("/health", healthRouter);
  
  return app;
}
```

**Route handler pattern:** Each v1 route file directly imports the SSE handler and passes the Hono `c` (context) `req` property, which is a standard `Request`:

```js
// apps/server/src/routes/v1/chat/completions.js
import { Hono } from "hono";
import { handleChat } from "../../handlers/chat.js";

const router = new Hono();

router.post("/chat/completions", async (c) => {
  // c.req.raw is a standard Request — pass directly to handleChat
  const response = await handleChat(c.req.raw);
  return response; // standard Response — Hono handles it natively
});

export { router as chatCompletionsRouter };
```

**Key advantage of Hono:** Zero bridging. The `src/sse/handlers/chat.js` function accepts a standard `Request` and returns a standard `Response`. Hono works with these natively. No Express conversion layer needed. Streaming, JSON parsing, and headers all work directly.

**Files to move (from `src/sse/` → `apps/server/src/`):**
```
src/sse/handlers/chat.js        → apps/server/src/handlers/chat.js
src/sse/handlers/embeddings.js  → apps/server/src/handlers/embeddings.js
src/sse/handlers/imageGeneration.js → apps/server/src/handlers/imageGeneration.js
src/sse/handlers/tts.js         → apps/server/src/handlers/tts.js
src/sse/handlers/stt.js         → apps/server/src/handlers/stt.js
src/sse/handlers/search.js      → apps/server/src/handlers/search.js
src/sse/handlers/fetch.js       → apps/server/src/handlers/fetch.js
src/sse/services/auth.js        → apps/server/src/services/auth.js
src/sse/services/model.js       → apps/server/src/services/model.js
src/sse/services/tokenRefresh.js → apps/server/src/services/tokenRefresh.js
src/sse/utils/logger.js         → apps/server/src/utils/logger.js
```

**Import rewrites needed in moved SSE handler files:**
| Current import | New import |
|---------------|------------|
| `@/lib/localDb` | `@9router/db` |
| `@/shared/constants/providers` | `@9router/shared/constants/providers` |
| `@/lib/headroom/detect` | `../../node_modules/@9router/shared/...` or keep in shared |
| `@/lib/network/connectionProxy` | `@9router/db` (moved into db package) |
| `@/lib/oauth/services/xai` | Dashboard-specific — **need to extract** |
| `open-sse/*` | `@9router/core/*` |

**Critical dependencies to extract:**
- `src/lib/headroom/detect` — needed by chat handler (`DEFAULT_HEADROOM_URL`). Move the `DEFAULT_HEADROOM_URL` constant to `@9router/shared/constants` or inline it in the server handler.
- `src/lib/network/connectionProxy` — needed by auth service (`resolveConnectionProxyConfig`). **MOVE to `@9router/db`** — it reads DB proxy pool config, so it belongs with the DB layer. Add it as a utility export from the db package.
- `src/lib/oauth/services/xai` — needed by tokenRefresh for XAI credentials. Extract credential constants into `@9router/core/config/` or into a small shared config file.

**Route files to create** (from `src/app/api/v1/` route files):

Each route file currently looks like:
```js
// Current: src/app/api/v1/chat/completions/route.js (Next.js App Router)
import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";

export async function POST(request) {
  await ensureInitialized();
  return await handleChat(request);
}
```

**New:** `apps/server/src/routes/v1/chat/completions.js` (Hono — no bridge needed):
```js
import { Hono } from "hono";
import { handleChat } from "../../handlers/chat.js";

const router = new Hono();

router.post("/chat/completions", async (c) => {
  const response = await handleChat(c.req.raw);
  return response;
});

export { router as chatCompletionsRouter };
```

**V1 route aggregator**: `apps/server/src/routes/v1/index.js` mounts all v1 sub-routers:
```js
import { Hono } from "hono";
import { chatCompletionsRouter } from "./chat/completions.js";
import { modelsRouter } from "./models.js";
import { embeddingsRouter } from "./embeddings.js";
// ... all other v1 routers

const v1 = new Hono();

v1.route("/", chatCompletionsRouter);
v1.route("/", modelsRouter);
v1.route("/", embeddingsRouter);
// ... mount all

export { v1 as v1Router };
```

**Health endpoint** (from `src/app/api/health/route.js`):
```js
// apps/server/src/routes/health.js
import { Hono } from "hono";

const router = new Hono();

router.get("/", async (c) => {
  try {
    const { getAdapter } = await import("@9router/db");
    await getAdapter();
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  } catch (err) {
    return c.json({ status: "error", message: err.message }, 500);
  }
});

export { router as healthRouter };
```

**Auth middleware** (extracted from `src/sse/services/auth.js`) — Hono middleware uses `c` context:
```js
// apps/server/src/middleware/auth.js
import { getSettings, validateApiKey } from "@9router/db";

export async function authMiddleware(c, next) {
  const reqPath = new URL(c.req.url).pathname;
  if (reqPath === "/health") return next();
  
  const settings = await getSettings();
  if (!settings.requireApiKey) return next();
  
  const apiKey = extractApiKey(c.req.raw);
  if (!apiKey) {
    return c.json({ error: { message: "Missing API key" } }, 401);
  }
  
  const valid = await validateApiKey(apiKey);
  if (!valid) {
    return c.json({ error: { message: "Invalid API key" } }, 401);
  }
  
  return next();
}

function extractApiKey(request) {
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  if (auth?.startsWith("sk-")) return auth;
  return null;
}
```

**IP security:** Skipped for the server. Clients connect directly to the server port (no reverse proxy layer), so XFF spoofing is not a concern. The `custom-server.js` IP stripping logic stays with the dashboard only (where a reverse proxy may front the Express-wrapped Next.js).

**Verification:**
- `npm run dev -w apps/server` starts server on port 20128
- `curl http://localhost:20128/v1/models` returns model list
- `curl http://localhost:20128/health` returns `{"status": "ok"}`
- Chat completion endpoint works with API key auth
- Server runs with ZERO Next.js dependencies

---

### Phase 5: `apps/dashboard` (Slimmed Next.js)

**What:** Move the existing Next.js app into `apps/dashboard/`, removing v1 API routes and cleaning up dependencies.

**Files to create:**
```
apps/dashboard/package.json
apps/dashboard/next.config.mjs
apps/dashboard/jsconfig.json
apps/dashboard/custom-server.js
apps/dashboard/Dockerfile
```

**`apps/dashboard/package.json`:**
```json
{
  "name": "9router-dashboard",
  "version": "0.5.8",
  "private": true,
  "scripts": {
    "dev": "next dev --webpack --port 20127",
    "build": "next build --webpack",
    "start": "next start"
  },
  "dependencies": {
    "next": "^16.1.6",
    "react": "19.2.4",
    "react-dom": "19.2.4",
    "@9router/core": "*",
    "@9router/db": "*",
    "@9router/shared": "*",
    "@dnd-kit/core": "^6.3.1",
    "@dnd-kit/modifiers": "^9.0.0",
    "@dnd-kit/sortable": "^10.0.0",
    "@dnd-kit/utilities": "^3.2.2",
    "@monaco-editor/react": "^4.7.0",
    "@xyflow/react": "^12.10.1",
    "bcryptjs": "^3.0.3",
    "express": "^5.2.1",
    "jose": "^6.1.3",
    "marked": "^18.0.1",
    "material-symbols": "^0.44.6",
    "recharts": "^3.7.0",
    "zustand": "^5.0.10",
    "http-proxy-middleware": "^3.0.5",
    "...": "...more UI deps"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4.3.0",
    "tailwindcss": "^4.3.0",
    "eslint": "^9",
    "eslint-config-next": "16.1.6",
    "postcss": "^8.5.15"
  }
}
```

**Files to move** (from root → `apps/dashboard/`):
```
Move:
  src/app/(dashboard)/*        → apps/dashboard/src/app/(dashboard)/
  src/app/(auth)/*              → apps/dashboard/src/app/ (if exists)
  src/app/login/*               → apps/dashboard/src/app/login/
  src/app/landing/*             → apps/dashboard/src/app/landing/
  src/app/layout.js             → apps/dashboard/src/app/layout.js
  src/app/page.js               → apps/dashboard/src/app/page.js
  src/app/globals.css           → apps/dashboard/src/app/globals.css
  src/app/favicon.ico           → apps/dashboard/src/app/favicon.ico
  src/app/manifest.js           → apps/dashboard/src/app/manifest.js
  src/app/error.js              → apps/dashboard/src/app/ (if exists)
  src/app/loading.js            → apps/dashboard/src/app/ (if exists)
  
  src/app/api/ (everything EXCEPT v1/ and v1beta/) → apps/dashboard/src/app/api/
  src/lib/ (everything EXCEPT db/) → apps/dashboard/src/lib/
  src/shared/ (everything EXCEPT constants/ + selective utils) → apps/dashboard/src/shared/
  src/dashboardGuard.js         → apps/dashboard/src/dashboardGuard.js
  src/proxy.js                  → apps/dashboard/src/proxy.js
  
  next.config.mjs               → apps/dashboard/next.config.mjs
  postcss.config.mjs            → apps/dashboard/postcss.config.mjs
  eslint.config.mjs             → apps/dashboard/eslint.config.mjs
  custom-server.js              → apps/dashboard/custom-server.js
  public/                       → apps/dashboard/public/
```

**DO NOT MOVE:**
- `src/app/api/v1/` — stays in root temporarily, then removed
- `src/app/api/v1beta/` — same
- `src/lib/db/` — already extracted to `packages/db`
- `src/shared/constants/` — already extracted to `packages/shared`
- `src/shared/utils/machineId.js` — extracted to `packages/shared`
- `src/shared/utils/ssrfGuard.js` — extracted to `packages/shared`
- `src/sse/` — moved to `apps/server/`

**`apps/dashboard/next.config.mjs`:** Remove ALL v1 rewrites — server handles v1 directly on its own port. Clients connect to `server:20128` for LLM API, `dashboard:20127` for UI.
```js
const nextConfig = {
  output: "standalone",
  // No /v1/* rewrites — those go to the server on port 20128 directly
  // Clients connect to server:20128 for LLM API calls, dashboard:20127 for UI
  async rewrites() {
    return [];
  },
  // ... rest of config stays
};
```

**`apps/dashboard/jsconfig.json`:**
```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```
(No `open-sse` alias needed — use `@9router/core` directly)

**Import rewrites needed in dashboard files:**
| Current import | New import |
|---------------|------------|
| `open-sse/*` | `@9router/core/*` |
| `@/lib/localDb` | `@9router/db` |
| `@/lib/db/*` | `@9router/db` or `@9router/db/src/*` |
| `@/shared/constants/*` | `@9router/shared/constants/*` |
| `@/shared/utils/machineId` | `@9router/shared/utils/machineId` |
| `@/shared/utils/ssrfGuard` | `@9router/shared/utils/ssrfGuard` |

**Dashboard API routes that stay** (20+ route groups — these manage the DB):

| Route Group | Purpose | API Pattern |
|-------------|---------|-------------|
| `auth/` | Dashboard login/logout/status | `GET/POST /api/auth/*` |
| `providers/` | Provider connection CRUD | `GET/POST/PUT/DELETE /api/providers/*` |
| `keys/` | API key management | `GET/POST/DELETE /api/keys/*` |
| `usage/` | Usage tracking & stats | `GET /api/usage/*` |
| `combos/` | Combo configuration | `GET/POST/PUT/DELETE /api/combos/*` |
| `settings/` | App settings | `GET/PATCH /api/settings` |
| `mcp/` | MCP tools management | `GET/POST /api/mcp/*` |
| `oauth/` | OAuth flows | `GET/POST /api/oauth/*` |
| `provider-nodes/` | Provider nodes | `GET/POST/PUT/DELETE /api/provider-nodes/*` |
| `proxy-pools/` | Proxy pool management | `GET/POST/PUT/DELETE /api/proxy-pools/*` |
| `health/` | Dashboard health | `GET /api/health` |
| `init/` | Initial setup | `GET/POST /api/init` |
| `version/` | Version info | `GET /api/version` |
| `tags/` | Tags management | `GET/POST /api/tags/*` |
| `headroom/` | Headroom proxy config | `GET/POST /api/headroom/*` |
| `translator/` | Translator status | `GET /api/translator/*` |
| `shutdown/` | Graceful shutdown | `POST /api/shutdown` |
| `cli-tools/` | CLI tools management | `GET /api/cli-tools/*` |
| `media-providers/` | Media provider config | `GET /api/media-providers/*` |
| `pricing/` | Pricing management | `GET/POST /api/pricing/*` |
| `locale/` | i18n | `GET /api/locale/*` |
| `tunnel/` | Tunnel management | `GET/POST /api/tunnel/*` |
| `models/` | Model management (dashboard-specific) | `GET /api/models/*` |
| `callback/` | OAuth callbacks | `GET /api/callback/*` |
| `data-summary/` | Data summary | `GET /api/data-summary` |
| `request-details/` | Request details | `GET /api/request-details/*` |

**Verification:**
- `npm run dev -w apps/dashboard` starts Next.js on port 20127
- Dashboard UI renders correctly
- Dashboard API routes work (provider CRUD, key management, settings, usage)
- No v1 routes in dashboard (they return 404 as expected — they're in the server now)

---

### Phase 6: CLI Update

**What:** Update the CLI (`cli/`) to launch `apps/server` instead of `.next/standalone/server.js`.

**Current behavior:** CLI builds/launches the Next.js standalone server (`node custom-server.js` from `.next/standalone/`).

**New behavior:** CLI launches `apps/server/src/index.js` (the standalone Hono server). Or better: the CLI should run the server from the monorepo workspace.

**Changes needed in `cli/cli.js`:**
- Instead of `require('./server.js')` (Next.js standalone), launch the server app
- The server app can be bundled with esbuild (CLI already uses esbuild) for distribution
- OR: the server app is published as a separate npm package `@9router/server`

**`cli/package.json` — add dependency:**
```json
{
  "dependencies": {
    "@9router/core": "*",
    "@9router/db": "*",
    "@9router/shared": "*"
  }
}
```

**Launch approach:** CLI spawns a child process running `apps/server/src/index.js` (in dev mode) or a bundled server binary (in production).

**Option A (dev):** `node apps/server/src/index.js` with NODE_PATH pointing to workspace node_modules.
**Option B (prod):** Bundle server with esbuild, include in CLI package.

**Recommendation:** Option A for now (the CLI already manages runtime dependencies via `~/.9router/runtime`). In a future phase, the server can be published separately.

**Verification:**
- `9router start` launches the server app
- Server reads config from DB (same as before)
- All existing CLI flows work (start, stop, status, tray)

---

### Phase 7: Docker + CI/CD

**What:** Update Dockerfiles and CI configuration.

**Two Dockerfiles needed:**

**`docker/dashboard.Dockerfile`** — builds the Next.js dashboard:
```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build -w packages/core && npm run build -w packages/db && \
    npm run build -w packages/shared && npm run build -w apps/dashboard

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/apps/dashboard/.next/standalone ./apps/dashboard
COPY --from=builder /app/apps/dashboard/public ./apps/dashboard/public
COPY --from=builder /app/packages ./packages
CMD ["node", "apps/dashboard/server.js"]
```

**`docker/server.Dockerfile`** — lightweight, no Next.js:
```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
CMD ["node", "apps/server/src/index.js"]
```

**CI/CD updates:**
- Separate build steps for dashboard + server
- Server image is smaller, faster to build
- Dashboard image still has Next.js output

**Verification:**
- `docker build -f docker/dashboard.Dockerfile -t 9router-dashboard .`
- `docker build -f docker/server.Dockerfile -t 9router-server .`
- Both images start correctly

---

### Dependency Flow Diagram

```
                     ┌──────────────────────────────────┐
                     │      9router-monorepo             │
                     │      (root workspace)              │
                     └──────────────────────────────────┘
                                    │
           ┌────────────────────────┼────────────────────────┐
           │                        │                        │
           ▼                        ▼                        ▼
   ┌─────────────────┐    ┌──────────────────┐     ┌──────────────────┐
   │  apps/dashboard  │    │   apps/server     │     │   apps/cli       │
   │  (Next.js)       │    │   (Hono)          │     │   (npm pkg)      │
   │                  │    │                   │     │                  │
   │  Deps:           │    │  Deps:            │     │  Deps:           │
   │  @9router/core   │    │  @9router/core    │     │  (bundled)       │
   │  @9router/db     │    │  @9router/db      │     │  enquirer/...    │
   │  @9router/shared │    │  @9router/shared  │     │  (launches       │
   │  next/react/...  │    │  hono             │     │   server as      │
   └────────┬────────┘    │  undici/uuid/...  │     │   child process) │
            │             └────────┬─────────┘     └──────────────────┘
            │                      │
            │          ┌───────────┴───────────┐
            │          │                       │
            ▼          ▼                       ▼
   ┌───────────────────────────────────────────────────────┐
   │                    Shared Packages                     │
   │                                                       │
   │  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐  │
   │  │ @9router/core│  │ @9router/db  │  │@9router/shared│ │
   │  │ (open-sse)   │  │ (SQLite +    │  │(constants/   │  │
   │  │              │  │  connectionProxy)│   utils)    │  │
   │  └──────┬───────┘  └──────┬───────┘  └──────┬──────┘  │
   └─────────┼────────────────┼─────────────────┼──────────┘
             │                │                  │
             ▼                ▼                  ▼
                     ┌──────────────────┐
                     │   SQLite DB file  │
                     │  (shared by both  │
                     │   apps via DATA_DIR)│
                     └──────────────────┘
```

---

### File Move / Rename Summary

**Complete list of files that change location:**

| From | To | Type |
|------|----|------|
| `open-sse/` (dir) | `packages/core/` | Move (full dir) |
| `src/lib/db/` (dir) | `packages/db/src/` | Move (full dir) |
| `src/shared/constants/` (dir) | `packages/shared/src/constants/` | Move (full dir) |
| `src/shared/utils/machineId.js` | `packages/shared/src/utils/machineId.js` | Copy + remove from src |
| `src/shared/utils/ssrfGuard.js` | `packages/shared/src/utils/ssrfGuard.js` | Copy + remove from src |
| `src/shared/utils/cn.js` | `packages/shared/src/utils/cn.js` | Copy + remove from src |
| `src/sse/handlers/chat.js` | `apps/server/src/handlers/chat.js` | Move + rewrite imports |
| `src/sse/handlers/embeddings.js` | `apps/server/src/handlers/embeddings.js` | Move + rewrite imports |
| `src/sse/handlers/imageGeneration.js` | `apps/server/src/handlers/imageGeneration.js` | Move + rewrite imports |
| `src/sse/handlers/tts.js` | `apps/server/src/handlers/tts.js` | Move + rewrite imports |
| `src/sse/handlers/stt.js` | `apps/server/src/handlers/stt.js` | Move + rewrite imports |
| `src/sse/handlers/search.js` | `apps/server/src/handlers/search.js` | Move + rewrite imports |
| `src/sse/handlers/fetch.js` | `apps/server/src/handlers/fetch.js` | Move + rewrite imports |
| `src/sse/services/auth.js` | `apps/server/src/services/auth.js` | Move + rewrite imports |
| `src/sse/services/model.js` | `apps/server/src/services/model.js` | Move + rewrite imports |
| `src/sse/services/tokenRefresh.js` | `apps/server/src/services/tokenRefresh.js` | Move + rewrite imports |
| `src/sse/utils/logger.js` | `apps/server/src/utils/logger.js` | Move + rewrite imports |
| `src/app/api/v1/` (dir) | `apps/server/src/routes/v1/` | Recreate (new files) |
| `src/app/api/v1beta/` (dir) | `apps/server/src/routes/v1beta/` | Recreate (new files) |
| `src/app/(dashboard)/` (dir) | `apps/dashboard/src/app/(dashboard)/` | Move |
| `src/app/login/` (dir) | `apps/dashboard/src/app/login/` | Move |
| `src/app/landing/` (dir) | `apps/dashboard/src/app/landing/` | Move |
| `src/app/api/*` (v1 excluded) | `apps/dashboard/src/app/api/` | Move |
| `src/lib/*` (db excluded) | `apps/dashboard/src/lib/` | Move |
| `next.config.mjs` | `apps/dashboard/next.config.mjs` | Move |
| `postcss.config.mjs` | `apps/dashboard/postcss.config.mjs` | Move |
| `public/` | `apps/dashboard/public/` | Move |
| `custom-server.js` | `apps/dashboard/custom-server.js` | Move |
| `Dockerfile` | Split into `docker/dashboard.Dockerfile` + `docker/server.Dockerfile` | Rewrite |

**Files that stay at root:**
- `cli/` (stays at root — published npm package)
- `README.md`, `LICENSE`, `CHANGELOG.md`
- `docs/`, `gitbook/`, `i18n/`, `images/`
- `scripts/`
- `.github/`

**Tests move per-package:** The root `tests/` directory is dissolved. Tests move into each package/app:
- `packages/core/tests/` — for core engine tests
- `packages/db/tests/` — for DB layer tests
- `packages/shared/tests/` — for shared constants tests
- `apps/server/tests/` — for server integration tests
- `apps/dashboard/tests/` — for dashboard tests
Existing `tests/` content is distributed to the appropriate locations.

**Files that are DELETED:**
- `src/app/api/v1/` (moved to server routes)
- `src/app/api/v1beta/` (moved to server routes)
- `.npmignore` (root — no longer publishing from root)

---

### Risk Assessment

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| **Import path breakage** — hundreds of `@/`, `open-sse/*` imports fail after moves | High | Certain | Phase imports: keep jsconfig path aliases working during transition. Use `@9router/*` for new imports. Run tests after each phase. |
| **Server doesn't start** — missing dependency or wrong import path | High | Medium | Test `npm run dev -w apps/server` immediately after Phase 4. Verify health endpoint. |
| **Dashboard API routes break** — imports changed but files moved | High | Medium | Dashboard is moved last (Phase 5). By then, `@9router/db` and `@9router/shared` packages are stable and tested. |
| **Database locking** — two processes writing to SQLite | Medium | Low | SQLite WAL mode handles concurrent readers. Dashboard is config authority. Server reads config and writes usage — no conflict on schema changes. Already handles this via adapter pattern. |
| **CLI no longer launches** — CLI points to paths that don't exist | High | High | CLI update is Phase 6 specifically to address this. The CLI finds the server by workspace path. |
| **Docker build fails** — monorepo structure not accounted for in Docker | Medium | High | Two Dockerfiles (Phase 7) with correct workspace-aware build steps. |
| **open-sse/ tokenRefresh breaks** — imports ../../src/lib/oauth/ | Medium | Low | Only 2 files, easy to fix. Extract credential constants into a config file within `@9router/core`. |
| **Performance regression** — Hono introduces overhead vs raw Node | Low | Low | Hono is sub-millisecond overhead. SSE handlers dominate latency (network I/O to LLM providers). Hono's native Request/Response support means zero bridging. |
| **Hot-reload stops working** — Next.js dev server won't reload changes in monorepo packages | Medium | Medium | Use `next dev --experimental-https` or symlink packages into dashboard's node_modules. Or use npm workspace resolution which handles this automatically. |

---

### Migration Order (Recommended Sequence)

```
Phase 0: Workspace skeleton (30 min)
  ↓
Phase 1: packages/core (1 hr)
  ↓
Phase 2: packages/db (1 hr)
  ↓
Phase 3: packages/shared (1 hr)
  ↓
Phase 4: apps/server (2-3 hr) ← Most complex
  ↓
Phase 5: apps/dashboard (2 hr) ← Second most complex
  ↓
Phase 6: CLI update (1 hr)
  ↓
Phase 7: Docker + CI/CD (1 hr)
```

**Total estimated effort:** ~9-11 hours of coding time across 8 phases.

**Each phase is independently revertible.** If Phase 4 (server) is too complex, the dashboard still works because all the packages are backward-compatible via path aliases.

---

### Execution Notes for Coder Sessions

**Do NOT attempt in one session.** Split across 4-6 coder sessions:

- **Session A:** Phases 0 + 1 (workspace + core package)
- **Session B:** Phases 2 + 3 (db + shared packages)
- **Session C:** Phase 4 (server app) — the biggest
- **Session D:** Phase 5 (dashboard move) — second biggest
- **Session E:** Phases 6 + 7 (CLI + Docker)

**Test after each phase:**
- After Phase 1: `npm run build -w packages/core` — core resolves
- After Phase 2: `npm run build -w packages/db` — db resolves
- After Phase 3: `npm run build -w packages/shared` — shared resolves
- After Phase 4: `curl http://localhost:20128/v1/models` — server works
- After Phase 5: `npm run dev -w apps/dashboard` — dashboard works
- After Phase 6: `9router start` — CLI launches server
- After Phase 7: Docker images build

**Import rewrite batch method:**
Use a systematic find-and-replace for each import path migration:

1. `open-sse/` → `@9router/core/` (53 occurrences)
2. `@/lib/localDb` → `@9router/db` (30+ occurrences)
3. `@/shared/constants/` → `@9router/shared/constants/` (20+ occurrences)
4. `@/shared/utils/machineId` → `@9router/shared/utils/machineId`
5. `@/shared/utils/ssrfGuard` → `@9router/shared/utils/ssrfGuard`

Use a script rather than manual edits for bulk replacements.
