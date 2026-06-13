# 9Router — vianhanif fork

Fork of [decolua/9router](https://github.com/decolua/9router) — a FREE AI router & token saver for CLI coding tools.

This fork adds **usage tracking** and **data management** features on top of upstream.

---

## Fork Changes

### V-001 — Monthly Usage Percentage (Jun 2026)

Track per-provider token/request breakdown by month for office reimbursement.

- **`GET /api/usage/stats?period=monthly&month=YYYY-MM`** — monthly aggregate: requests, prompt/completion tokens per provider
- **`GET /api/usage/export?month=YYYY-MM&format=csv|json`** — export raw monthly data
- **MonthlyOverviewCards** — dashboard usage page shows stat cards per month (requests, tokens, providers active)
- **ProviderPercentageTable** — per-provider percentage breakdown of total requests/tokens for a given month
- **Month picker** — dropdown to select which month to view (defaults to current)
- **Seed script** (`scripts/seed-from-opencode.mjs`) — backfill usage data from OpenCode session history via `better-sqlite3`
- Removed Donate button from Header
- Fixed PostCSS/Tailwind v4 escape bug (replaced `shadow-[var(--...)]` with CSS utility classes)

### V-002 — Data Management (Jun 2026)

Prevent unbounded SQLite database growth with retention-based cleanup.

- **`GET /api/usage/data-summary`** — aggregated stats: total months, total requests, total tokens, database file size, oldest/newest record dates
- **`GET /api/usage/clear?action=dry-run&months=N`** — preview rows that would be deleted
- **`POST /api/usage/clear`** — delete data older than N months from `usageHistory`, `usageDaily`, and `requestDetails` (single transaction)
- **DataSummaryCard** — 4-tile stat display on profile page with date range subtitle
- **DataManagementSection** — collapsible retention selector (1/3/6/12 months) with live preview and confirmation modal
- Safety: two-step flow (preview → confirm), no "delete everything" option, success toast with hard-refresh prompt

---

## Upstream

Full README, features, setup guide, and docs at [github.com/decolua/9router](https://github.com/decolua/9router).
