# V-001 — Monthly Usage Percentage Feature

## Overview

**Worktree:** `.worktrees/V-001-usage-monitoring-feature`
**Feature Branch:** `feature/V-001-usage-monitoring-feature`
**Base Branch:** `master`
**PR:** https://github.com/vianhanif/9router/pull/1

Add a monthly usage percentage feature showing per-provider token/request breakdown for reimbursement reporting. The system must prove 75% usage per provider for billing purposes.

### Business Goal
Generate monthly reports showing usage percentage per provider/model — required for reimbursement documentation.

### Success Criteria
- User can select a "Monthly" period that aggregates all days in the chosen month
- Per-provider and per-model percentages are displayed with visual progress bars
- Monthly reports can be exported as CSV/JSON
- Export includes provider name, requests, request %, tokens, token %

---

## Scope Table

| # | Scope | Files | Complexity |
|---|-------|-------|------------|
| 1 | Backend — monthly aggregation function | `src/lib/db/repos/usageRepo.js` | Medium |
| 2 | Backend — API route extension | `src/app/api/usage/stats/route.js` | Low |
| 3 | Backend — export endpoint (NEW) | `src/app/api/usage/export/route.js` | Medium |
| 4 | Frontend — Monthly period + month picker | `src/shared/components/UsageStats.js`, `src/app/(dashboard)/dashboard/usage/page.js` | Medium |
| 5 | Frontend — Percentage display + progress bars | `src/app/(dashboard)/dashboard/usage/components/ProviderPercentageTable.js` | Medium |
| 6 | Data backfill — seed from OpenCode sessions | `scripts/seed-from-opencode.mjs` | Medium |

---

## Implementation

### 1. Backend: Monthly Aggregation (`usageRepo.js`)

**File:** `src/lib/db/repos/usageRepo.js`

#### 1a. Add `getMonthlyUsage(yearMonth)` function

Add a new exported function alongside the existing `getUsageStats()`:

```javascript
export async function getMonthlyUsage(yearMonth) {
  // yearMonth format: "2026-06"
  const db = await getAdapter();

  // Load all usageDaily rows for the given month
  const dayRows = db.all(
    `SELECT dateKey, data FROM usageDaily WHERE dateKey LIKE ?`,
    [`${yearMonth}-%`]
  );

  // Aggregate per-provider
  const byProvider = {};
  let totals = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  for (const dr of dayRows) {
    const day = parseJson(dr.data, {});
    for (const [prov, p] of Object.entries(day.byProvider || {})) {
      if (!byProvider[prov]) {
        byProvider[prov] = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      }
      byProvider[prov].requests += p.requests || 0;
      byProvider[prov].promptTokens += p.promptTokens || 0;
      byProvider[prov].completionTokens += p.completionTokens || 0;
    }
  }

  // Compute totals
  totals.requests = Object.values(byProvider).reduce((s, p) => s + p.requests, 0);
  totals.promptTokens = Object.values(byProvider).reduce((s, p) => s + p.promptTokens, 0);
  totals.completionTokens = Object.values(byProvider).reduce((s, p) => s + p.completionTokens, 0);
  totals.totalTokens = totals.promptTokens + totals.completionTokens;

  // Compute percentages
  for (const prov of Object.keys(byProvider)) {
    const p = byProvider[prov];
    p.totalTokens = p.promptTokens + p.completionTokens;
    p.requestPercentage = totals.requests > 0 ? (p.requests / totals.requests) * 100 : 0;
    p.tokenPercentage = totals.totalTokens > 0 ? (p.totalTokens / totals.totalTokens) * 100 : 0;
  }

  // Also aggregate byModel for detail view
  const byModel = {};
  for (const dr of dayRows) {
    const day = parseJson(dr.data, {});
    for (const [mk, m] of Object.entries(day.byModel || {})) {
      const rawModel = m.rawModel || mk.split("|")[0];
      const provider = m.provider || mk.split("|")[1] || "";
      const modelKey = provider ? `${rawModel} (${provider})` : rawModel;
      if (!byModel[modelKey]) {
        byModel[modelKey] = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, rawModel, provider };
      }
      byModel[modelKey].requests += m.requests || 0;
      byModel[modelKey].promptTokens += m.promptTokens || 0;
      byModel[modelKey].completionTokens += m.completionTokens || 0;
    }
  }
  for (const mk of Object.keys(byModel)) {
    const m = byModel[mk];
    m.totalTokens = m.promptTokens + m.completionTokens;
    m.requestPercentage = totals.requests > 0 ? (m.requests / totals.requests) * 100 : 0;
    m.tokenPercentage = totals.totalTokens > 0 ? (m.totalTokens / totals.totalTokens) * 100 : 0;
  }

  return {
    month: yearMonth,
    byProvider,
    byModel,
    totals,
    days: dayRows.length,
  };
}
```

**Design decisions:**
- Uses `LIKE` query on `dateKey` to match `YYYY-MM-DD` format → efficiently filters to the month
- **24-month range limit:** Reject months older than 24 months from the current month to prevent performance issues on long-running deployments with large datasets
- Computes both `requestPercentage` and `tokenPercentage` per provider and per model
- Returns both `byProvider` and `byModel` breakdowns for flexible frontend display
- No new DB tables needed — fully leverages existing `usageDaily` data

**No change to `getUsageStats()`** — the new function operates independently since it has different semantics (absolute month, percentages, export-ready structure).

#### 1b. Export the new function

Add to the barrel in `src/lib/db/index.js`:

```javascript
export {
  // ... existing exports ...
  getMonthlyUsage,
} from "./repos/usageRepo.js";
```

Also add to the shim in `src/lib/usageDb.js`:

```javascript
export {
  // ... existing exports ...
  getMonthlyUsage,
} from "@/lib/db/index.js";
```

---

### 2. Backend: API Route Extension (`stats/route.js`)

**File:** `src/app/api/usage/stats/route.js`

```javascript
import { getUsageStats, getMonthlyUsage } from "@/lib/usageDb";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all", "monthly"]);

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    if (period === "monthly") {
      const month = searchParams.get("month");
      if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        return NextResponse.json({ error: "Invalid month format. Use YYYY-MM." }, { status: 400 });
      }
      // Enforce 24-month range limit
      const [yr, mo] = month.split("-").map(Number);
      const monthsAgo = (new Date().getFullYear() - yr) * 12 + (new Date().getMonth() + 1 - mo);
      if (monthsAgo < 0 || monthsAgo > 24) {
        return NextResponse.json({ error: "Month out of range. Max 24 months history." }, { status: 400 });
      }
      const stats = await getMonthlyUsage(month);
      return NextResponse.json(stats);
    }

    const stats = await getUsageStats(period);
    return NextResponse.json(stats);
  } catch (error) {
    console.error("[API] Failed to get usage stats:", error);
    return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500 });
  }
}
```

---

### 3. Backend: Export Endpoint (NEW)

**File:** `src/app/api/usage/export/route.js` (new directory)

```javascript
// src/app/api/usage/export/route.js
import { NextResponse } from "next/server";
import { getMonthlyUsage } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period");
    const month = searchParams.get("month");
    const format = searchParams.get("format") || "json";

    if (period !== "monthly" || !month || !/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json({ error: "Specify period=monthly&month=YYYY-MM" }, { status: 400 });
    }

    if (!["json", "csv"].includes(format)) {
      return NextResponse.json({ error: "Format must be 'json' or 'csv'" }, { status: 400 });
    }

    const data = await getMonthlyUsage(month);

    if (format === "csv") {
      // RFC 4180 CSV quoting helper
      const csvEscape = (val) => {
        const str = String(val);
        if (str.includes(",") || str.includes('"') || str.includes("\n")) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

      // Build CSV rows from byProvider
      const headers = ["Provider", "Requests", "Request %", "Input Tokens", "Output Tokens", "Total Tokens", "Token %"];
      const rows = Object.entries(data.byProvider).map(([provider, stats]) => [
        provider,
        stats.requests,
        stats.requestPercentage.toFixed(2),
        stats.promptTokens,
        stats.completionTokens,
        stats.totalTokens,
        stats.tokenPercentage.toFixed(2),
      ]);

      // Add totals row
      rows.push([
        "TOTAL",
        data.totals.requests,
        "100.00",
        data.totals.promptTokens,
        data.totals.completionTokens,
        data.totals.totalTokens,
        "100.00",
      ]);

      const csvContent = [
        headers.map(csvEscape).join(","),
        ...rows.map((r) => r.map(csvEscape).join(",")),
      ].join("\n");

      return new NextResponse(csvContent, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="usage-report-${month}.csv"`,
        },
      });
    }

    // JSON format
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Export failed:", error);
    return NextResponse.json({ error: "Export failed" }, { status: 500 });
  }
}
```

**Design decisions:**
- Separate endpoint from stats to keep concerns clean (stats = UI data, export = file download)
- CSV format uses simple string building (no third-party CSV lib needed for this use case)
- Content-Disposition header triggers browser download
- JSON format returns the full structured data for programmatic consumption

---

### 4. Frontend: Monthly Period + Month Picker

#### 4a. Update `UsageStats.js`

**File:** `src/shared/components/UsageStats.js`

**Changes:**

1. **Add "Monthly" to `PERIODS` array:**
```javascript
const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
  { value: "monthly", label: "Monthly" },
];
```

2. **Add state for month picker:**
```javascript
const [selectedMonth, setSelectedMonth] = useState(() => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
});
```

3. **Modify the fetch URL in the period change effect:**
```javascript
useEffect(() => {
  if (isInitialLoad.current) {
    isInitialLoad.current = false;
    setLoading(true);
  } else {
    setFetching(true);
  }

  let url = `/api/usage/stats?period=${period}`;
  if (period === "monthly") {
    url += `&month=${selectedMonth}`;
  }

  fetch(url)
    .then((r) => r.ok ? r.json() : null)
    .then((data) => {
      if (data) setStats((prev) => ({ ...prev, ...data }));
    })
    .catch(() => {})
    .finally(() => {
      setLoading(false);
      setFetching(false);
    });
}, [period, selectedMonth]);
```

4. **Add month picker UI** next to or below the period selector when "monthly" is active:
```jsx
{period === "monthly" && (
  <div className="flex items-center gap-2">
    <input
      type="month"
      value={selectedMonth}
      onChange={(e) => setSelectedMonth(e.target.value)}
      className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/50"
      style={{ colorScheme: 'auto' }}
    />
  </div>
)}
```

5. **Add "Export" button** with `fetch` + `Blob` download for error handling:

```javascript
const [exporting, setExporting] = useState(false);

async function handleExport(format) {
  setExporting(true);
  try {
    const res = await fetch(`/api/usage/export?period=monthly&month=${selectedMonth}&format=${format}`);
    if (!res.ok) throw new Error("Export failed");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `usage-report-${selectedMonth}.${format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error("Export error:", e);
    // Optionally show user-facing error toast
  } finally {
    setExporting(false);
  }
}
```

```jsx
{period === "monthly" && (
  <div className="flex items-center gap-2">
    <button
      onClick={() => handleExport("csv")}
      disabled={exporting}
      className="rounded-md px-3 py-1.5 text-sm font-medium bg-surface border border-border hover:bg-bg-hover transition-colors disabled:opacity-50"
    >
      {exporting ? "Exporting..." : "Export CSV"}
    </button>
    <button
      onClick={() => handleExport("json")}
      disabled={exporting}
      className="rounded-md px-3 py-1.5 text-sm font-medium bg-surface border border-border hover:bg-bg-hover transition-colors disabled:opacity-50"
    >
      {exporting ? "Exporting..." : "Export JSON"}
    </button>
  </div>
)}
```

6. **Add Monthly Overview Card Variant**

   Create a new overview card layout for monthly view that replaces the standard `OverviewCards` when `period === "monthly"`:

   ```jsx
   // Inline or as a sub-component in UsageStats.js
   function MonthlyOverviewCards({ stats }) {
     // Sort providers by token percentage descending
     const sorted = Object.entries(stats.byProvider || {})
       .sort(([, a], [, b]) => b.tokenPercentage - a.tokenPercentage);

     const topProvider = sorted[0];

     return (
       <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4 sm:gap-4">
         {/* Total requests card */}
         <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
           <span className="text-text-muted text-sm uppercase font-semibold">Total Requests</span>
           <span className="truncate text-2xl font-bold">{fmt(stats.totals.requests)}</span>
         </Card>

         {/* Total tokens card */}
         <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
           <span className="text-text-muted text-sm uppercase font-semibold">Total Tokens</span>
           <span className="truncate text-2xl font-bold">{fmt(stats.totals.totalTokens)}</span>
         </Card>

         {/* Top provider card */}
         <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
           <span className="text-text-muted text-sm uppercase font-semibold">Top Provider</span>
           <span className="truncate text-2xl font-bold">{topProvider?.[0] || "—"}</span>
           <span className="text-xs text-text-muted">
             {topProvider?.[1]?.tokenPercentage?.toFixed(1) || "0"}% of tokens
           </span>
         </Card>

         {/* Days with data card */}
         <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
           <span className="text-text-muted text-sm uppercase font-semibold">Days Active</span>
           <span className="truncate text-2xl font-bold">{stats.days}</span>
         </Card>
       </div>
     );
   }
   ```

   This renders in `UsageStats.js` conditionally:
   ```jsx
   {period === "monthly"
     ? <MonthlyOverviewCards stats={stats} />
     : <OverviewCards stats={stats} />
   }
   ```

---

### 5. Frontend: Percentage Display + Progress Bars

#### 5a. New "Provider Percentage" view mode in `UsageStats.js`

Add a new viewMode option `"percentage"` in the existing Costs/Tokens toggle:

```javascript
const [viewMode, setViewMode] = useState("costs");
```

Add a third button for "Percentage" view. When `viewMode === "percentage"` and `period === "monthly"`, display:

- Provider name + model name
- Total requests (and % of total)
- Total tokens (and % of total)
- Visual progress bar for request % and token %

#### 5b. ProviderPercentageTable Component (NEW)

Create `src/app/(dashboard)/dashboard/usage/components/ProviderPercentageTable.js`:

**`ProviderPercentageTable`** is a simple stateless component:
- Receives `byProvider` data with pre-computed percentages
- Renders a table with columns: **Provider, Requests, Request %, Tokens, Token %**
- **Token % is the primary sort column** (descending by default) — the metric that matters for the 75% reimbursement proof
- Each provider row has a progress bar showing token percentage
- Progress bar colors **reuse the exact provider color scheme from `ProviderTopology.js`** for visual consistency
- Each row also shows the raw numbers (requests and tokens) alongside their percentages
- A totals row at the bottom shows combined numbers and 100%

**Option B:** Extend `UsageTable.js` with percentage-aware columns when the data includes percentage fields. Simpler but less clean separation.

**Recommendation: Option A** for cleaner code. Create:

```
src/app/(dashboard)/dashboard/usage/components/ProviderPercentageTable.js
```

#### 5c. Progress bar component

Create a reusable `ProgressBar` component (or inline in the percentage table):

```jsx
function ProgressBar({ percent, color = "var(--color-primary)", label }) {
  const clamped = Math.min(Math.max(percent || 0, 0), 100);
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-bg-subtle rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${clamped}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-xs font-medium text-text-muted w-12 text-right">
        {label || `${clamped.toFixed(1)}%`}
      </span>
    </div>
  );
}
```

---

### 6. Provider Colors for Progress Bars

**Extract provider colors from `ProviderTopology.js`** by importing the provider-to-color mapping used in the topology view. This guarantees visual consistency across the dashboard. The existing `ProviderTopology` likely has a color assignment per provider (often using a hashed palette or a fixed map).

Implementation approach:
1. Examine `ProviderTopology.js` to find how it assigns colors to providers
2. Export a `getProviderColor(providerId)` function from either `ProviderTopology.js` or create a shared `providerColors.js` utility
3. Import and reuse in `ProviderPercentageTable.js`

Alternatively, if extraction is complex, define a fixed palette that matches the dashboard styling:
```javascript
const PROVIDER_COLORS = [
  "#3B82F6", "#10B981", "#F59E0B", "#EF4444",
  "#8B5CF6", "#EC4899", "#06B6D4", "#84CC16",
];
```

---

## Files Modified (Summary)

| File | Action | Description |
|------|--------|-------------|
| `src/lib/db/repos/usageRepo.js` | **Modify** | Add `getMonthlyUsage(yearMonth)` function |
| `src/lib/db/index.js` | **Modify** | Export `getMonthlyUsage` |
| `src/lib/usageDb.js` | **Modify** | Re-export `getMonthlyUsage` |
| `src/app/api/usage/stats/route.js` | **Modify** | Add "monthly" support + month param |
| `src/app/api/usage/export/route.js` | **NEW** | Export endpoint (CSV/JSON) |
| `src/shared/components/UsageStats.js` | **Modify** | Add Monthly period, month picker, export buttons, monthly overview cards, month picker outside `hidePeriodSelector` guard |
| `src/app/(dashboard)/dashboard/usage/components/ProviderPercentageTable.js` | **NEW** | Percentage breakdown table with progress bars |
| `src/app/(dashboard)/dashboard/usage/page.js` | **Modify** | Add "Monthly" period option |
| `scripts/seed-from-opencode.mjs` | **NEW** | Backfill script reads OpenCode session DB and inserts into 9router usage tables |

### OpenCode Integration
- 9router added as a provider in `~/.config/opencode/opencode.json` (npm: `@ai-sdk/openai-compatible`, baseURL: `http://localhost:20128/api/v1`)
- Model prefixes: `oc/` for free OpenCode, `ocg/` for paid OpenCode Go
- All agent models changed from `opencode/big-pickle` to `9router/oc/big-pickle` for proxy routing

---

## Data Flow

```
User selects "Monthly" period
  → UsageStats shows month picker input (type="month")
  → User selects a month (e.g. 2026-06)
  → Fetch GET /api/usage/stats?period=monthly&month=2026-06
  → API calls getMonthlyUsage("2026-06")
    → Queries usageDaily WHERE dateKey LIKE "2026-06-%"
    → Aggregates byProvider and byModel with percentages
    → Returns { month, byProvider, byModel, totals, days }
  → Frontend displays:
    - Monthly-specific overview cards (totals, top provider, days active)
    - ProviderPercentageTable with progress bars (chart is hidden for monthly)
    - Export button (fetch + Blob download) → /api/usage/export?period=monthly&month=2026-06&format=csv
```

---

## Risks & Considerations

1. **No new database tables** — the existing `usageDaily` table stores all data needed. The `dateKey` has a `PRIMARY KEY` index so `LIKE` queries on `YYYY-MM-%` will scan the full table but this is acceptable since `usageDaily` has at most 365 rows/year. A **24-month range limit** is enforced to prevent performance issues on long-running deployments.

2. **Empty months** — if no data exists for the selected month, the function returns zero totals gracefully.

3. **Partial months** — the current month will have incomplete data until the month ends. This is acceptable behavior.

4. **No live streaming** — monthly data is static (never changes for past months). The SSE stream for real-time updates is not needed for monthly view.

5. **Export format** — CSV uses **RFC 4180 quoting** (cells containing commas, quotes, or newlines are wrapped in double quotes with internal quotes escaped).

6. **Edge case: 100% single provider** — the 75% proof target means a single provider may show 100%. All display logic should handle 0-100% range gracefully.

---

## Testing Results

- [x] `getMonthlyUsage("2026-05")` — 56 requests, 17.8M tokens across 7 days ✅
- [x] `getMonthlyUsage("2026-06")` — 293 requests, 36.7M tokens across 9 days ✅
- [x] API `period=monthly&month=2026-05` — returns byProvider with correct percentages ✅
- [x] API invalid month — returns 400 error ✅
- [x] CSV export — correct headers (Provider, Requests, Request %, Input Tokens, Output Tokens, Total Tokens, Token %) + TOTAL row ✅
- [x] JSON export — same structure as stats endpoint ✅
- [x] Month picker updates data via `selectedMonth` state → re-fetches on change ✅
- [x] Null guard for `MonthlyOverviewCards` — fixed crash when `stats.totals` is undefined ✅
- [x] Month picker visible even with `hidePeriodSelector=true` ✅
- [x] 9router proxy — routes OpenCode requests through 9router, returns HTTP 200 ✅
- [x] Seed script — 223 historical sessions seeded across 15 days (May 24 – Jun 12) ✅
- [x] Build passes with `next build` — no errors ✅
