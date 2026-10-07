# L2 — Tool-Schema Relevance Ranking (P0.5)

- Date: 2026-10-07
- Ticket: L2
- Status: **DRAFT — awaiting confirmation. No code written.**
- Base branch: `decolua/9router:master` (`a99cf572`), worked on `feature/tool-schema-ranking` in a worktree off `upstream/master`
- Upstream verdict: ✅ Strong PR
- Design source: `2026-10-05-9router-intelligence-stack-design.md` §4 item 2; task list #5

---

## Task Overview

**What.** Extend `open-sse/utils/toolDeduper.js` with a lexical relevance scorer, `rankTools()`, that drops tool definitions which share **no word** with the current request's recent messages. Flag-gated, default **OFF**, fail-open.

**Why.** Every request carries 303–369 tool definitions, ~42% of the payload (~293 KB of `tools=`). p50 input cache reuse is 97.5%, so most requests pay nothing for it — but cache-miss requests pay in full, and the 60.7 s watchdog case sat at **2%** reuse with ~107 K uncached tokens. Only *dropping* tools reduces bytes; reordering does not.

**Success criteria.**

1. Flag OFF (default) → request body byte-identical to current behaviour.
2. Flag ON → measurable reduction in `tools=` bytes on tool-heavy requests.
3. Zero request-path failures — any error inside ranking leaves tools untouched (never throws).
4. Existing `tests/unit/tool-deduper.test.js` specs continue to pass unchanged.
5. Dropped-tool set and before/after byte count are logged, so effect is measurable from logs.

---

## Assumptions

1. Lexical overlap is an adequate proxy for relevance. `open-sse/` has **no** embeddings, tokenizer, or scoring prior art (verified — grep for `score|rank|relevance|similarity|embed` returns only an unrelated Gemini schema-type picker). None will be added.
2. Only dropping saves tokens. Reordering is out of scope.
3. The win is concentrated on cache-miss requests (design doc §5.6). Measurement must filter on cache reuse, not average across all traffic.
4. The tool block can be sized with `JSON.stringify(...).length / 4` — the existing `estimateInputTokens` heuristic (`open-sse/utils/usageTracking.js:341`). Savings are reported as an **estimate**, not a tokenizer count.
5. Thresholds are named module constants, not DB settings. Knobs are added only if measurement shows the defaults are wrong.
6. The flag follows the existing pattern: DB `settings` row → `chat.js` → `handleChatCore` opts, exactly like `rtkEnabled` / `ponytailEnabled`.
7. Existing per-request opt-out header `x-9router-token-saver: off` (`config/runtimeConfig.js:68`) also disables ranking — ranking is part of the token-saver family.
8. `chatCore.js:222` has **no try/catch** around `dedupeTools`; it trusts the module never to throw. Ranking must honour that contract internally.
9. A dashboard toggle belongs beside the existing token-saver toggles for consistency.
10. Upstream may object that tool selection is agent responsibility (task list §4: *"9router acts as a capability registry, not a tool selector"*). Mitigated by: flag default OFF, zero-overlap-only rule, keep-floor, and an explicit measurement-first framing.

---

## Impact Scope

| # | Scope | Repository | Complexity |
|---|-------|------------|------------|
| 1 | `open-sse/utils/toolDeduper.js` — add `rankTools()` | `9router` | Medium |
| 2 | `open-sse/handlers/chatCore.js` — chain ranking after dedupe | `9router` | Low |
| 3 | `src/lib/db/repos/settingsRepo.js` — add flag default | `9router` | Low |
| 4 | `src/sse/handlers/chat.js` — read flag, forward to core | `9router` | Low |
| 5 | `src/app/(dashboard)/dashboard/token-saver/TokenSaverClient.js` — toggle | `9router` | Low |
| 6 | `tests/unit/tool-deduper.test.js` — new specs | `9router` | Low |

No changes to: translator, executors, providers, database schema, or any response path.

---

## Change Approach

### Files to modify / create

| File | Change |
|------|--------|
| `open-sse/utils/toolDeduper.js` | add `tokenize()`, `buildQueryText()`, exported `rankTools(tools, opts)` |
| `open-sse/handlers/chatCore.js` | after line 222, chain `rankTools` when flag on |
| `src/lib/db/repos/settingsRepo.js` | `toolRankEnabled: false` in `DEFAULT_SETTINGS` |
| `src/sse/handlers/chat.js` | `toolRankEnabled: !!chatSettings.toolRankEnabled` |
| `src/app/(dashboard)/dashboard/token-saver/TokenSaverClient.js` | toggle control |
| `tests/unit/tool-deduper.test.js` | specs for scoring, floor, cap, fail-open |

### Module constants (single source, documented ceiling)

```js
const RANK_MIN_TOOLS  = 16;  // skip ranking below this count
const RANK_KEEP_RATIO = 0.5; // always keep >= 50% of tools
const RANK_DROP_CAP   = 0.4; // never drop > 40% of tools
const RANK_QUERY_MSGS = 3;   // messages used to build the query text
const RANK_QUERY_MAX  = 8000;// chars of query text considered
```

`ponytail:` thresholds are fixed at module scope; promote to `settingsRepo` only if measurement shows they are wrong for real traffic.

### Algorithm

1. **Fail-open guard.** Whole body wrapped in `try/catch`; on any error return `{ tools, stripped: [] }` unchanged. Never throws.
2. **Skip when small.** If `tools.length < RANK_MIN_TOOLS` → return unchanged.
3. **Build query text** from the last `RANK_QUERY_MSGS` messages of `translatedBody.messages`, extracting `content` as string or as array-of-parts (`{type:"text",text}`), truncated to `RANK_QUERY_MAX` chars. If empty → return unchanged (fail open).
4. **Tokenize** both sides: lowercase → split `/[^a-z0-9]+/` → length ≥ 2 → strip a minimal stopword list.
5. **Score per tool.** `tokens = tokenize(name + " " + description)`. `score = |tokens ∩ queryTokens|`. Additionally: if the raw query text contains the tool `name` as a substring (case-insensitive) → **force keep** (the client explicitly named it).
6. **Candidates** = tools with `score === 0` and not force-kept.
7. **Bound the cut.**
   - `keepFloor = ceil(tools.length * RANK_KEEP_RATIO)`
   - `maxDrop  = floor(tools.length * RANK_DROP_CAP)`
   - sort candidates by JSON byte size **descending**, drop from the head until either bound is hit — largest-first maximises bytes saved per dropped tool; the keep-floor bounds the blast radius.
8. **Return** `{ tools: kept, stripped: droppedNames }`, preserving input order for kept tools.

### Order of changes

1. `settingsRepo.js` — add `toolRankEnabled: false` (no behaviour change).
2. `toolDeduper.js` — add `rankTools()` + helpers; existing `dedupeTools` untouched.
3. `chat.js` — read and forward the flag.
4. `chatCore.js` — chain `rankTools` behind `toolRankEnabled && tokenSaverEnabled`.
5. `TokenSaverClient.js` — toggle.
6. `tests/unit/tool-deduper.test.js` — specs.
7. Verify: `node --check` on changed files, then the test suite.

### Call-site shape

```js
// open-sse/handlers/chatCore.js, immediately after the existing dedupe block (line ~227)
if (toolRankEnabled && tokenSaverEnabled && Array.isArray(translatedBody.tools)) {
  const ranked = rankTools(translatedBody.tools, { messages: translatedBody.messages });
  if (ranked.stripped.length > 0) {
    translatedBody.tools = ranked.tools;
    log?.debug?.("TOOLRANK", `dropped ${ranked.stripped.length}: ${ranked.stripped.slice(0, 5).join(", ")} ...`);
  }
}
```

### Measurement

The `TOOLRANK` debug line supplies dropped count + names; before/after byte counts come from `JSON.stringify` length either side of the call. Combined with the `% reused` value from PR #4649 (`requestDetail.js`), this isolates the **cache-miss** bucket — the only bucket where this feature can win.

---

## Risks / Side Effects

| Risk | Severity | Mitigation |
|------|----------|------------|
| A needed tool is dropped; agent cannot call it | **High** | Flag default **OFF**; zero-overlap rule only; keep ≥50%; drop ≤40%; skip when <16 tools; force-keep on named tool; `x-9router-token-saver: off` also disables |
| Lexical false negatives (tool needed but no shared words) | Medium | Accepted while flag is off; revisited after measurement |
| Upstream rejects router-side tool selection on architectural grounds | Medium | Flag-gated, default off, framed as measured token optimisation; can be split out if review demands |
| Savings overstated (chars/4 heuristic, no tokenizer) | Low | Label as estimate; real number comes from provider-reported uncached `prompt_tokens` |
| Silent failure in ranking breaks the request path | **High** | Entire body `try/catch`; returns original tools; never throws (matches `rtk`/`headroom` fail-open contract, `open-sse/AGENTS.md`) |

**Explicit non-goals:** no embeddings, no tokenizer dependency, no schema of ranking weights, no changes to `dedupeTools` semantics, no response-path changes.

---

## Halt

Per planner protocol: **no code may be written until this plan is confirmed.**
