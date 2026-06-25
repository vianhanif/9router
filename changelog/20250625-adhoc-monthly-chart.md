# Task Plan: Monthly Token/Cost Chart for Usage Dashboard

## Overview
- **What**: Enable the daily time-series token/cost area chart when `period=monthly` is selected
- **Why**: Currently the chart is explicitly hidden for monthly view (`period !== "monthly"` guard)
- **Success**: Chart renders daily buckets for the selected billing period month (e.g., `cutoffDay=5` → Feb 5 → Mar 4), with tokens and cost toggle

## Key Design

**Billing period alignment**: The chart date range follows the billing cycle, NOT calendar month.
- `selectedMonth = "2026-02"` + `cutoffDay = 5` → range: `2026-02-05` → `2026-03-05` (exclusive)
- This is identical to how `getMonthlyUsage` computes its date range
- Daily buckets span exactly the same window as the stats/tables for that month

## Scope

| # | Scope | Target Branch | Repository | Complexity | Est. Lines |
|---|-------|---------------|------------|------------|------------|
| 1 | Repo layer: extend `getChartData` with monthly support | `feature/adhoc-monthly-chart` | 9router | Low | ~35 added |
| 2 | API route: accept `monthly` period + pass month/cutoffDay params | `feature/adhoc-monthly-chart` | 9router | Low | ~12 added |
| 3 | UsageChart: pass month + cutoffDay params to API | `feature/adhoc-monthly-chart` | 9router | Low | ~6 changed |
| 4 | UsageStats: remove monthly chart guard, pass month to chart | `feature/adhoc-monthly-chart` | 9router | Low | ~4 changed |

**Total**: ~85 lines across 4 files (mostly due to API route restructure into handlers). Single feature branch, no MR complexity.

## Detailed Changes

### 1. Repo Layer — `src/lib/db/repos/usageRepo.js`

**Change**: Extend `getChartData()` with a `monthly` branch.

- Accept signature: `getChartData(period, options = {})` where options = `{ yearMonth, cutoffDay }`
- Add `if (period === "monthly")` branch before the existing period logic
- **Date range computation**: Copy from `getMonthlyUsage` (L625-645):
  - Parse `yearMonth` → `[yr, mo]`
  - `startDate = new Date(yr, mo - 1, cutoffDay || 1)`
  - Adjust if `startDate.getDate() !== cutoffDay` → `startDate.setDate(0)` (month-end clamp)
  - `endDate = new Date(startDate); endDate.setMonth(endDate.getMonth() + 1)`
  - Adjust if `endDate.getDate() !== startDate.getDate()` → `endDate.setDate(0)` (month-end clamp)
  - Format keys as `YYYY-MM-DD`
- Query: `SELECT dateKey, data FROM usageDaily WHERE dateKey >= ? AND dateKey < ?`
- **Gap-filling**: Iterate date range startDate → endDate (exclusive), build dayMap from rows, backfill zeros for missing days
- Return `[{label: "Feb 05", tokens: N, cost: N}, ...]` — label format: `month short + day` (same as 7d/30d/60d)

**Edge cases**:
- **Empty month/cutoffDay range**: Return zero-filled day array → chart shows "No data"
- **Missing days**: Not every day has data → fill gaps with `{tokens: 0, cost: 0}`
- **Cost field**: Same as existing — read `dayData.cost` from parsed JSON, fallback to 0
- **Future month**: Computed range may be entirely in future → all zeros → chart shows "No data"
- **Invalid yearMonth**: Throws — API layer catches
- **cutoffDay > 28**: Date arithmetic handles naturally (Feb 30 → adjusted to Feb 28/29)

**Estimate**: ~35 new lines

### 2. API Route — `src/app/api/usage/chart/route.js`

**Change**: Split GET into two handlers — `handleStandardChart` (existing periods) and `handleMonthlyChart` (monthly).

```javascript
async function handleStandardChart(period) {
  const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d"]);
  if (!VALID_PERIODS.has(period)) return null; // let monthly handler try
  return NextResponse.json(await getChartData(period));
}

async function handleMonthlyChart(searchParams) {
  const month = searchParams.get("month");
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: "Invalid month format (expected YYYY-MM)" }, { status: 400 });
  }
  const cutoffDay = Math.min(Math.max(parseInt(searchParams.get("cutoffDay")) || 1, 1), 28);
  
  // 24-month boundary check
  const [yr, mo] = month.split("-").map(Number);
  const now = new Date();
  const monthsAgo = (now.getFullYear() - yr) * 12 + (now.getMonth() + 1 - mo);
  if (monthsAgo > 24) {
    return NextResponse.json({ error: "Month exceeds 24-month range" }, { status: 400 });
  }
  
  const data = await getChartData("monthly", { yearMonth: month, cutoffDay });
  return NextResponse.json(data);
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";
    
    if (period === "monthly") return handleMonthlyChart(searchParams);
    const result = await handleStandardChart(period);
    if (!result) return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    return result;
  } catch (error) {
    console.error("[API] Failed to get chart data:", error);
    return NextResponse.json({ error: "Failed to fetch chart data" }, { status: 500 });
  }
}
```

**Estimate**: ~35 new lines (existing ~21 lines restructured)

### 3. UsageChart — `src/app/(dashboard)/dashboard/usage/components/UsageChart.js`

**Change**: Accept `month` and `cutoffDay` props, pass them to API fetch.

- Add props: `month?: string, cutoffDay?: number`
- Update fetch URL in `fetchData` callback:
  ```javascript
  const params = new URLSearchParams({ period });
  if (period === "monthly" && month && cutoffDay != null) {
    params.set("month", month);
    params.set("cutoffDay", cutoffDay);
  }
  const res = await fetch(`/api/usage/chart?${params}`);
  ```
- PropTypes: add `month` and `cutoffDay`
- X-axis: 28-31 daily labels → current `interval="preserveStartEnd"` will crowd on narrow screens. Fix: add dynamic `interval` prop — use `Math.floor(data.length / 5)` for monthly (~1 label per 5-6 days), keep `preserveStartEnd` for shorter periods. Implement via derived prop in rendering:
  ```javascript
  // For monthly: show ~5 evenly spaced labels across 28-31 days
  // For other periods: preserve start and end labels
  const xInterval = period === "monthly" && data.length > 0
    ? Math.max(1, Math.floor(data.length / 5))
    : "preserveStartEnd";
  ```
  Pass as `<XAxis interval={xInterval} ... />` — must be computed *after* data loads, or guarded for empty data.

**Estimate**: ~10 lines changed

### 4. UsageStats — `src/shared/components/UsageStats.js`

**Change**: Remove the `period !== "monthly"` guard (L681), pass `month` and `cutoffDay` to chart.

```javascript
// Before (L681):
{loading ? null : period !== "monthly" && <UsageChart period={period} />}

// After:
{loading ? null : <UsageChart period={period}
  month={period === "monthly" ? selectedMonth : undefined}
  cutoffDay={period === "monthly" ? cutoffDay : undefined}
/>}
```

**Loading behavior**: When `period=monthly` and `cutoffDay` is still null (initial fetch from settings), UsageStats already returns early at L384 without stats. The chart will receive `cutoffDay=null` — UsageChart should guard against this by not fetching until `cutoffDay != null`. Add a condition in `fetchData`:
```javascript
if (period === "monthly" && (cutoffDay == null)) return;
```

**Estimate**: ~4 lines changed

## Design Decision: Extend vs New Function

**Recommendation**: Extend `getChartData()` rather than create `getMonthlyChartData()`.

**Rationale**:
- Same return shape `[{label, tokens, cost}]` — no interface divergence
- Single entry point for chart data → easier to maintain
- Avoids code duplication (date computation, gap-filling, cost lookup)
- UsageChart already has a single `period` prop → no new conditional logic needed
- Only difference is params (month + cutoffDay vs period) → cleanly handled via optional `options` object

## Edge Cases Summary

| Case | Handling |
|------|----------|
| No data for selected month | Return zero-filled array, chart shows "No data for this period" (existing UsageChart behavior) |
| Current month (partial) | `cutoffDay` shifts start date → only days from cutoff to today shown |
| Future month | Should return all zeros — API can optionally validate `month <= currentMonth` |
| Cost = undefined | `dayData.cost || 0` (same pattern as existing 7d/30d/60d) |
| Missing days in month | Iterate full date range, backfill zeros from dayMap (same as existing logic) |
| Invalid YYYY-MM | API returns 400 |
| Month > 24 months ago | API returns 400 (consistency with getMonthlyUsage) |

## Test Considerations

**Manual testing**:
1. Navigate to `/dashboard/usage` → select "Monthly"
2. Verify chart renders with daily buckets for current month
3. Change month picker to a past month → verify chart updates
4. Toggle tokens/cost → verify both display correctly
5. Check partial month (current month with cutoffDay != 1)
6. Check empty month (no usage) → verify "No data" message
7. Verify x-axis labels don't overlap on 31-day months

**No existing test files found** for this component — no automated tests to update.
