# 3-Level Click-to-Drill-Down on Usage Chart

## Overview

Add drill-down zoom to the usage chart in `/dashboard/usage`, allowing users to click a daily data point to see hourly breakdown, then click an hour to see per-minute breakdown.

## State Machine

```
granularity: "day" | "hour" | "minute"

day level (7d/30d/60d/monthly periods)
  → click day (must have dateKey)
  → granularity="hour", drillTarget={ dateKey }
  → fetch: GET /api/usage/chart?granularity=hour&dateKey=YYYY-MM-DD

hour level (24 buckets, HH:MM labels)
  → click hour with hourIndex
  → granularity="minute", drillTarget={ dateKey, hour }
  → fetch: GET /api/usage/chart?granularity=minute&dateKey=YYYY-MM-DD&hour=N
  → "← Back" → back to day (drillTarget=null)

minute level (60 buckets, HH:MM labels)
  → "← Back" → back to hour (drillTarget={ dateKey })
```

**Guard:** Drill-down is only enabled for daily-granularity periods (7d, 30d, 60d, monthly). Periods `today` and `24h` are already hourly — no drill-down.

**Reset:** Switching the period selector while zoomed in resets to `granularity="day"`.

---

## Files

### 1. `src/lib/db/repos/usageRepo.js` — Data Layer

**Function:** `getChartData(period, options)` at line 721

**Add `"hourly"` period** (insert after existing `24h` block, before line 803):

```
bucketCount = 24, bucketMs = 3600000
startMs = start of day from options.dateKey
endMs = startMs + 24 * bucketMs
labelFn: toLocaleTimeString({hour: "2-digit", minute: "2-digit"})
Query: SELECT timestamp, promptTokens, completionTokens, cost
       FROM usageHistory WHERE timestamp >= ? AND timestamp < ?
Bucketing: Math.floor((t - startMs) / bucketMs), clamp [0, 23]
```

**Add `"minute"` period** (insert after `"hourly"` block):

```
bucketCount = 60, bucketMs = 60000
startMs = dateKey T hour:00:00
endMs = startMs + 3600000
labelFn: toLocaleTimeString({hour: "2-digit", minute: "2-digit"})
         → "14:00", "14:01", ..., "14:59"
Query: same pattern, WHERE timestamp >= ? AND timestamp < ?
Bucketing: Math.floor((t - startMs) / bucketMs), clamp [0, 59]
```

**Return shape:** `{ label, tokens, cost }[]` (same as all existing periods).

**Add `dateKey` to daily responses:**
- Monthly (line 746): add `dateKey: key`
- 7d/30d/60d (line 817): add `dateKey`

**Complexity:** Medium (30 lines total)

---

### 2. `src/app/api/usage/chart/route.js` — API Route

**Add dispatch for new `granularity` param** (insert in GET handler at line 30):

```js
const granularity = searchParams.get("granularity");
const dateKey = searchParams.get("dateKey");

if (granularity === "hour" && dateKey) {
  return NextResponse.json(await getChartData("hourly", { dateKey }));
}
if (granularity === "minute" && dateKey) {
  const hour = parseInt(searchParams.get("hour"));
  if (isNaN(hour) || hour < 0 || hour > 23) {
    return NextResponse.json({ error: "Invalid hour (0-23)" }, { status: 400 });
  }
  return NextResponse.json(await getChartData("minute", { dateKey, hour }));
}
```

**Validation:** Reject malformed dateKey via regex `/^\d{4}-\d{2}-\d{2}$/`. Reject hour outside 0-23.

**Backward compat:** `granularity` param is optional. All existing `?period=7d` calls unaffected. Only the new drill URL pattern uses `granularity`.

**Complexity:** Low (15 lines)

---

### 3. `src/app/(dashboard)/dashboard/usage/components/UsageChart.js` — Frontend Chart

149 lines → ~210 lines. recharts `AreaChart` component.

**Props:** Unchanged (`period`, `month`, `cutoffDay`).

**New state:**
```js
const [granularity, setGranularity] = useState("day");
const [drillTarget, setDrillTarget] = useState(null);
```

**Derived:**
```js
const isDrillable = !["today", "24h"].includes(period);
const drillLabel = granularity === "hour" && drillTarget?.dateKey
  ? new Date(drillTarget.dateKey + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })
  : granularity === "minute" && drillTarget?.hour !== undefined
  ? `${drillTarget.dateKey} ${String(drillTarget.hour).padStart(2, "0")}:00`
  : "";
```

**Update `fetchData`:**
```js
let url;
if (granularity === "hour" && drillTarget?.dateKey) {
  url = `/api/usage/chart?granularity=hour&dateKey=${drillTarget.dateKey}`;
} else if (granularity === "minute" && drillTarget?.dateKey && drillTarget?.hour !== undefined) {
  url = `/api/usage/chart?granularity=minute&dateKey=${drillTarget.dateKey}&hour=${drillTarget.hour}`;
} else {
  url = `/api/usage/chart?period=${period}`;
  if (period === "monthly") url += `&month=${month}&cutoffDay=${cutoffDay}`;
}
```

Add `granularity`, `drillTarget` to deps array.

**Add data enrichment** — after fetch, attach metadata to each point:
- Day-level: `data[i].dateKey = dateKey` (already added from backend)
- Hour-level: `data[i].hourIndex = i` (0-23)

**Click handler:**
```js
const handleDataPointClick = (data) => {
  if (!isDrillable) return;
  if (!data?.activePayload?.[0]?.payload) return;
  const payload = data.activePayload[0].payload;

  if (granularity === "day" && payload.dateKey) {
    setDrillTarget({ dateKey: payload.dateKey });
    setGranularity("hour");
  } else if (granularity === "hour" && payload.hourIndex !== undefined) {
    setDrillTarget(prev => ({ dateKey: prev.dateKey, hour: payload.hourIndex }));
    setGranularity("minute");
  }
};
```

**Back handler:**
```js
const handleBack = () => {
  if (granularity === "minute") {
    setDrillTarget(prev => ({ dateKey: prev.dateKey }));
    setGranularity("hour");
  } else {
    setDrillTarget(null);
    setGranularity("day");
  }
};
```

**Add `onClick` to `<AreaChart>` component (line 80):**
```diff
-<AreaChart data={data} margin={{...}}>
+<AreaChart data={data} margin={{...}} onClick={isDrillable && granularity !== "minute" ? handleDataPointClick : undefined}>
```

**Add "← Back" button** (after Card wrapper, before view toggle):
```jsx
{granularity !== "day" && (
  <button
    onClick={handleBack}
    className="flex items-center gap-1 text-sm text-text-muted hover:text-text transition-colors px-1"
  >
    ← {granularity === "hour" ? `Back to daily` : `Back to ${drillLabel}`}
  </button>
)}
```

**Reset on period change:**
```js
useEffect(() => {
  setGranularity("day");
  setDrillTarget(null);
}, [period]);
```

**Complexity:** High (~60 lines)

---

## Dependency Order

```
usageRepo.js (1) → chart/route.js (2) → UsageChart.js (3)
```

All sequential — each depends on the previous.

---

## Edge Cases & Risks

| Risk | Mitigation |
|---|---|
| `usageHistory` table large → slow minute query | 1-hour window + `timestamp` index = fast index scan |
| 60 x-axis labels cramped | Use recharts `interval` prop (same pattern as monthly) |
| Click on chart gutter (not a point) | `data?.activePayload?.[0]?.payload` guard — no-op |
| Period switch while zoomed | `useEffect` resets to `granularity="day"` |
| Date with zero data | Returns empty buckets — existing empty-state handles it |
| Rapid double-click | `setLoading(true)` prevents re-fetch until response arrives |
| Timezone consistency | Same pattern as existing `today`/`24h` — uses `new Date()` local TZ |
| `dateKey` collisions on monthly | Already unique per day in monthly iteration |

---

## Risk Assessment

- **Overall complexity:** Medium
- **Backward compatible:** Yes — `granularity` is optional param, `dateKey` is additive to response
- **Breaking changes:** None
- **Performance:** Acceptable — 1-hour `usageHistory` scan is fast with timestamp index
