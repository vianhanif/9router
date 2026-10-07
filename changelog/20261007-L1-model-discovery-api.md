# L1 — Model Discovery API

- Date: 2026-10-07
- Ticket: L1
- Status: **DRAFT — awaiting confirmation. No code written.**
- Base branch: `decolua/9router:master` (`a99cf572`), worked on `feature/model-discovery-api` in a worktree off `upstream/master`
- Upstream verdict: ✅ Strong PR
- Design source: task list #4; task list §4 (architectural resolution — 9router as capability registry)

---

## Task Overview

**What.** Add the discovery surface an agent can query instead of guessing:

1. `GET /v1/models` — **filtered** catalog (`?capability=&min_context=&kind=&q=&limit=`)
2. `POST /v1/models/query` — structured shortlist endpoint
3. `GET /api/models/router` — **authenticated** internal infra view (availability / health / usage / cost)

**Why.** Task list §4: every request carries 303–369 tools. The agreed architectural answer is *agent-side discovery* — the agent asks 9router what exists and decides — rather than the router selecting tools. 9router becomes a capability registry.

**Premise correction (verified).** The task list states *"existing `/v1/models` is a hardcoded stub."* This is **false**. `src/app/api/v1/models/route.js:650` derives its list via `buildModelsList()` from static `PROVIDER_MODELS` + live resolvers (Kiro/Qoder/GitHub/Cursor/Zed) + aliases + combos + disabled models, and already returns OpenAI-compatible records with `capabilities`, `context_length`, `max_completion_tokens`. `GET /v1/models/{provider}/{model}` and `GET /v1/models/info?id=` already exist with capabilities/context. Scope is therefore **~100–200 lines, not 300–500**.

**Success criteria.**

1. No new query params → `/v1/models` and `/v1/models/{id}` responses are byte-identical to today.
2. Filter params return correctly narrowed sets.
3. `/api/models/router` is refused without valid auth (JWT / CLI token) — no new auth code, inherited from `dashboardGuard`.
4. Zero changes to `/v1/chat/completions` or any request path.
5. Existing v1-model tests pass unchanged.

---

## Assumptions

1. **Corrected scope.** Catalog and single-model capabilities already exist and are not redesigned. Only the three items above are added.
2. `POST /v1/models/query` does not conflict with the existing catch-all: `src/app/api/v1/models/[...model]/route.js` exports only `OPTIONS` and `GET` (verified), and Next.js resolves a static segment (`query`) ahead of a dynamic catch-all. Asserted by a test.
3. Capability vocabulary is derived from the keys of `getCapabilitiesForModel(provider, model)` (`open-sse/providers/capabilities.js:623`): `vision`, `tools`, `reasoning`, `search`, `audioInput`, `imageOutput`. **Exact key set must be confirmed at build time** before freezing the query-param contract.
4. **Latency is unverified.** `usageHistory` columns are `provider, model, connectionId, endpoint, promptTokens, completionTokens, cost, status, meta, timestamp` — **no duration**. Latency can only be reported if timing lives in `meta` JSON or `requestDetails`. **Resolve at build; if absent, omit latency** rather than fabricate it.
5. **Quota is not numeric.** Only `rateLimitedUntil`, `backoffLevel`, and `modelLock_{id}` timestamps exist. The infra view reports **lock state**, not quota percentages.
6. Cost comes from `usageHistory.cost` (decimal). There is no per-model pricing table with historical trends.
7. **"Routing tags" ≈ combo membership.** No tags field or tags table exists. Derive from `combos.models` plus `combos.kind` (`"llm"` / `"webSearch"` / `"webFetch"`).
8. Auth for `/api/models/router` is free: `dashboardGuard.js:52` treats all `/api/*` as deny-by-default (JWT / CLI token / `requireLogin:false`).
9. `/api/models/availability` already returns per-model lock state; the new infra view must **aggregate** it, not duplicate it.
10. Filtering is applied to the existing `buildModelsList()` output; no change to how that list is built.

---

## Impact Scope

| # | Scope | Repository | Complexity |
|---|-------|------------|------------|
| 1 | `src/app/api/v1/models/route.js` — query-param filtering | `9router` | Low–Medium |
| 2 | `src/app/api/v1/models/query/route.js` — **new** shortlist endpoint | `9router` | Low |
| 3 | `src/app/api/models/router/route.js` — **new** infra view | `9router` | Medium |
| 4 | `tests/` — filter, shadowing, auth, shape | `9router` | Low |

No changes to: `buildModelsList()`, capabilities resolution, translators, executors, DB schema, or any completions path.

---

## Change Approach

### Files to modify / create

| File | Change |
|------|--------|
| `src/app/api/v1/models/route.js` | read `request.nextUrl.searchParams`; filter the `buildModelsList()` result |
| `src/app/api/v1/models/query/route.js` | **new** — `POST` returning a shortlist |
| `src/app/api/models/router/route.js` | **new** — `GET`, authenticated infra view |
| `tests/unit/v1-models-filter.test.js` | **new** — filter + shadowing |
| `tests/unit/api-models-router.test.js` | **new** — shape + auth refusal |

### 1. `GET /v1/models` filtering

Read `request.nextUrl.searchParams`. When **no** filter param is present, return the current response unchanged (guards byte-compatibility).

| Param | Semantics |
|-------|-----------|
| `capability` | repeatable (or comma-separated); keep models whose `capabilities[X] === true`. Unknown values → 400. |
| `min_context` | integer; keep `context_length >= N`. |
| `kind` | keep `kind === value` (`llm` / `image` / `tts` / `stt` / `embedding` / `imageToText` / web). |
| `q` | case-insensitive substring over `id` and display name. |
| `limit` | positive integer; truncate after filtering (no pagination cursor — matches existing no-pagination convention). |

Response envelope and record shape are **unchanged** (`{ object: "list", data: [...] }`).

### 2. `POST /v1/models/query`

Body:

```json
{
  "capabilities": ["vision", "tools"],
  "min_context": 128000,
  "max_output": 64000,
  "kind": "llm",
  "q": "code",
  "owned_by": "anthropic",
  "exclude": ["alias/model-id"],
  "limit": 20
}
```

- Applies the same predicates as §1, plus `max_output`, `owned_by`, `exclude`.
- Unknown capability in `capabilities` → 400 with the valid vocabulary listed.
- Returns `{ object: "list", data: [...] }`, deterministic order (`owned_by`, then `id`), default `limit` 20, hard cap 100.
- Stateless — no DB writes.

### 3. `GET /api/models/router`

Suggested shape (aggregates existing repos; **no new tables**):

```json
{
  "object": "router.models",
  "generatedAt": "2026-10-07T…Z",
  "period": "24h",
  "data": [
    {
      "id": "anthropic/claude-opus-5",
      "owned_by": "anthropic",
      "kind": "llm",
      "available": true,
      "health": {
        "status": "active",
        "backoffLevel": 0,
        "rateLimitedUntil": null,
        "lastError": null,
        "lastErrorAt": null
      },
      "usage": {
        "requests": 0,
        "errors": 0,
        "promptTokens": 0,
        "completionTokens": 0,
        "cost": 0,
        "avgLatencyMs": null
      },
      "routing": { "combos": ["name-a"], "primary": true },
      "capabilities": { "…": true },
      "context_length": 200000
    }
  ]
}
```

Data sources:

| Field | Source |
|-------|--------|
| `available`, `health.*` | `providerConnections` (`testStatus`, `backoffLevel`, `rateLimitedUntil`, `modelLock_*`, `lastError`) — same data as `/api/models/availability` |
| `usage.*` | `usageHistory` via `usageRepo.getUsageStats(period)` / `getChartData(period)` |
| `usage.avgLatencyMs` | **only if** timing is present in `meta` / `requestDetails`; otherwise `null` |
| `routing.*` | `combos` table (`models` array membership; `primary` = first model of a combo) |
| `capabilities`, `context_length` | `getCapabilitiesForModel()` / registry |

Bound `period` to a closed set (`24h` default, `7d` allowed) so `usageHistory` aggregation stays indexed by `timestamp`.

### Order of changes

1. `/v1/models` filter params (smallest, byte-compat guarded) + tests.
2. `POST /v1/models/query` (new static route) + shadowing test.
3. `/api/models/router` + auth-refusal test.
4. Full suite run; confirm zero regressions against `a99cf572`.

### Open questions to close at build (blocking these subtasks only, not the plan)

1. Exact capability key set from `getCapabilitiesForModel()` — freezes the vocab.
2. Whether any per-request duration exists (`meta` / `requestDetails`) — decides `avgLatencyMs`.
3. Whether a per-model pricing source exists beyond `usageHistory.cost`.

---

## Risks / Side Effects

| Risk | Severity | Mitigation |
|------|----------|------------|
| `/v1/models` response drifts for existing clients | **High** | Filtering only activates when a param is present; byte-compat asserted by test |
| `POST /v1/models/query` shadowed by `[...model]` catch-all | Medium | Catch-all has no `POST`; static segment wins; asserted by test |
| Infra view leaks internal state | **High** | Lives under `/api/*` (deny-by-default via `dashboardGuard`); asserted by 401/redirect test. Never placed on the public `/v1/*` path (design doc §5.1) |
| `/api/models/router` duplicates `/api/models/availability` | Low | Aggregate existing data; do not re-implement lock logic |
| `usageHistory` aggregation slow on large windows | Low | Closed `period` set; `timestamp` is indexed |
| `buildModelsList()` cost per call (live resolvers) | Low | Unchanged from today; do not add caching in this task |

**Explicit non-goals:** no redesign of existing `/v1/models` or `/v1/models/{id}` records; no new DB tables; no changes to completions/routing behaviour; no pagination framework.

---

## Halt

Per planner protocol: **no code may be written until this plan is confirmed.**
