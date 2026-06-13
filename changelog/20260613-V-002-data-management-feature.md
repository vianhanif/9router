# V-002 — Data Management Feature

## Overview

**Worktree:** `.worktrees/V-002-data-management`
**Feature Branch:** `feature/V-002-data-management`
**Base Branch:** `master`

Add data management capabilities to the 9router usage tracking system, enabling users to view data accumulation summaries and selectively clear old usage history from the settings page.

### Business Goal
Users accumulate usage history indefinitely with no cleanup mechanism. This feature provides visibility into how much data has been collected and a safe, user-controlled way to prune old records — preventing unbounded database growth while preserving recent data.

### Success Criteria
- Settings page shows a data summary card with: months tracked, total requests, total tokens, DB file size
- User can select a retention period (1/3/6/12 months or Keep All) in a "Data Management" section
- Before deletion, user sees a confirmation popup with row count, date range, and irreversible-warning
- After deletion, a success toast shows number of rows removed
- Data cannot be deleted accidentally — confirmation is explicit
- All states (loading, empty, error) are handled gracefully

---

## Scope Table

| # | Scope | Files | Complexity | Estimate |
|---|-------|-------|------------|----------|
| 1 | Backend — Data summary API | `src/app/api/usage/data-summary/route.js` (NEW) | Low | 0.5h |
| 2 | Backend — Data clearing API | `src/app/api/usage/clear/route.js` (NEW) | Low | 0.5h |
| 3 | Backend — Usage repo queries | `src/lib/db/repos/usageRepo.js` | Low | 0.5h |
| 4 | Frontend — Data summary card component | `src/app/(dashboard)/dashboard/profile/components/DataSummaryCard.js` (NEW) | Low | 0.5h |
| 5 | Frontend — Data management section | `src/app/(dashboard)/dashboard/profile/components/DataManagementSection.js` (NEW) | Medium | 1h |
| 6 | Frontend — Confirmation dialog | Inline in DataManagementSection (reuse ConfirmModal) | Low | 0.5h |
| 7 | Frontend — Integration into profile page | `src/app/(dashboard)/dashboard/profile/page.js` | Low | 0.5h |

**Total Estimated Complexity:** Medium (mostly isolated additions, no cross-service impact)

---

## Detailed Implementation

### 1. Backend: Usage Repo Queries (`src/lib/db/repos/usageRepo.js`)

Add the following new exported functions to `usageRepo.js`. Do NOT modify any existing functions.

#### 1a. `getDataSummary()`

Returns an object with:
- `totalMonths`: number — count of distinct year-month combinations in usageHistory (or usageDaily)
- `totalRequests`: number — count of rows in usageHistory
- `totalTokens`: number — sum of promptTokens + completionTokens across usageHistory
- `dbFileSize`: number | null — file size in bytes from `fs.statSync(DATA_FILE)`, or null if stat fails

```javascript
import fs from "node:fs";
import { DATA_FILE } from "../paths.js";

export async function getDataSummary() {
  const db = await getAdapter();

  const totalRequests = (db.get(`SELECT COUNT(*) as c FROM usageHistory`)?.c) || 0;
  const totalTokens = (db.get(`SELECT COALESCE(SUM(promptTokens), 0) + COALESCE(SUM(completionTokens), 0) as t FROM usageHistory`)?.t) || 0;

  // Count distinct months from usageHistory timestamps
  const monthRows = db.all(`SELECT DISTINCT substr(timestamp, 1, 7) as ym FROM usageHistory ORDER BY ym`);
  const totalMonths = monthRows.length;

  // DB file size
  let dbFileSize = null;
  try { dbFileSize = fs.statSync(DATA_FILE)?.size ?? null; } catch {}

  return { totalMonths, totalRequests, totalTokens, dbFileSize };
}
```

**Edge cases:**
- Empty table → return 0 for counts, null for file size
- `fs.statSync` on missing/deleted file → catch and set to null
- Very large row counts → COUNT(*) and SUM are fast with SQLite

#### 1b. `getOldestRecordDate()`

Returns the ISO timestamp string of the oldest usageHistory row.

```javascript
export async function getOldestRecordDate() {
  const db = await getAdapter();
  const row = db.get(`SELECT MIN(timestamp) as ts FROM usageHistory`);
  return row?.ts || null;
}
```

#### 1c. `getDeletePreview(cutoffDate)`

Returns count and date range info for rows that would be deleted by a given cutoff date.

```javascript
export async function getDeletePreview(cutoffDate) {
  const db = await getAdapter();
  const historyCount = (db.get(`SELECT COUNT(*) as c FROM usageHistory WHERE timestamp < ?`, [cutoffDate])?.c) || 0;
  const minRow = db.get(`SELECT MIN(timestamp) as min FROM usageHistory WHERE timestamp < ?`, [cutoffDate]);
  const maxRow = db.get(`SELECT MAX(timestamp) as max FROM usageHistory WHERE timestamp < ?`, [cutoffDate]);
  return {
    historyCount,
    dateRange: { from: minRow?.min || null, to: maxRow?.max || null },
  };
}
```

#### 1d. `deleteUsageData(cutoffDate, cutoffDateKey)`

Deletes usageHistory rows older than cutoffDate and usageDaily rows with dateKey older than (or equal to) cutoffDateKey. Also clears `requestDetails` rows older than cutoffDate. Runs in a single transaction. Returns the number of history rows deleted.

```javascript
export async function deleteUsageData(cutoffDate, cutoffDateKey) {
  const db = await getAdapter();
  let deletedCount = 0;

  db.transaction(() => {
    const result = db.run(`DELETE FROM usageHistory WHERE timestamp < ?`, [cutoffDate]);
    deletedCount = result.changes || 0;
    db.run(`DELETE FROM usageDaily WHERE dateKey < ?`, [cutoffDateKey]);
    db.run(`DELETE FROM requestDetails WHERE timestamp < ?`, [cutoffDate]);
  });

  return deletedCount;
}
```

**Design notes:**
- `dateKey` format is `YYYY-MM-DD` — compare lexicographically with `< cutoffDateKey` to delete entire days
- The transaction ensures atomicity: all three tables stay consistent
- `requestDetails` uses the same `timestamp < cutoffDate` pattern and its `idx_rd_ts` index
- We keep usageDaily rows where dateKey >= cutoffDateKey even if some individual rows in that day are gone (no harm, daily summary is an approximation anyway)

**After clearing, the frontend should show a prompt for the user to hard-refresh the page (e.g., F5 or Cmd+R) to clear in-memory caches.**

---

### 2. Backend: Data Summary API — `src/app/api/usage/data-summary/route.js` (NEW)

**Route:** `GET /api/usage/data-summary`

Returns:
```json
{
  "totalMonths": 6,
  "totalRequests": 15234,
  "totalTokens": 4582300,
  "dbFileSize": 8388608
}
```

```javascript
import { NextResponse } from "next/server";
import { getDataSummary } from "@/lib/db/repos/usageRepo.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const summary = await getDataSummary();
    return NextResponse.json(summary);
  } catch (error) {
    console.error("[API] Failed to get data summary:", error);
    return NextResponse.json({ error: "Failed to fetch data summary" }, { status: 500 });
  }
}
```

---

### 3. Backend: Data Clearing API — `src/app/api/usage/clear/route.js` (NEW)

Two distinct endpoints in one file:

- **Dry-run (GET):** `GET /api/usage/clear?action=dry-run&months=N` — returns preview data without modifying the database. No rows are touched.
- **Execute (POST):** `POST /api/usage/clear` with body `{ months: N }` — performs the actual deletion after user confirms.

The `action` parameter names are `"dry-run"` (not `"preview"`) to make the non-destructive semantics unambiguous.

#### 3a. Preview (GET)

`GET /api/usage/clear?action=dry-run&months=N`

Returns preview of what would be deleted without deleting anything. No database writes occur.

```javascript
import { NextResponse } from "next/server";
import { getDeletePreview, getOldestRecordDate, deleteUsageData } from "@/lib/db/repos/usageRepo.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action");
    const months = parseInt(searchParams.get("months"), 10);

    if (!["dry-run"].includes(action)) {
      return NextResponse.json({ error: "Invalid action. Use 'dry-run'." }, { status: 400 });
    }

    const oldestDate = await getOldestRecordDate();
    if (!oldestDate) {
      return NextResponse.json({ totalMonths: 0, oldestDate: null, preview: null, oldestRecordDate: null });
    }

    // Compute total months tracked
    const oldest = new Date(oldestDate);
    const now = new Date();
    const totalMonths = (now.getFullYear() - oldest.getFullYear()) * 12 + (now.getMonth() - oldest.getMonth());

    // Compute cutoff date based on months param
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const cutoffDate = cutoff.toISOString();
    const cutoffDateKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;

    const preview = await getDeletePreview(cutoffDate);

    return NextResponse.json({
      totalMonths,
      oldestDate,
      preview,
      cutoffDate,
    });
  } catch (error) {
    console.error("[API] clear preview failed:", error);
    return NextResponse.json({ error: "Failed to get clear preview" }, { status: 500 });
  }
}
```

#### 3b. Execute (POST)

`POST /api/usage/clear`

Body:
```json
{
  "months": 6
}
```

Response:
```json
{
  "success": true,
  "deletedRows": 5231,
  "cutoffDate": "2025-12-13T00:00:00.000Z"
}
```

```javascript
export async function POST(request) {
  try {
    const body = await request.json();
    const months = parseInt(body.months, 10);

    if (![1, 3, 6, 12].includes(months)) {
      return NextResponse.json({ error: "Invalid retention period. Must be 1, 3, 6, or 12 months." }, { status: 400 });
    }

    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const cutoffDate = cutoff.toISOString();
    const cutoffDateKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;

    const deletedRows = await deleteUsageData(cutoffDate, cutoffDateKey);

    return NextResponse.json({ success: true, deletedRows, cutoffDate });
  } catch (error) {
    console.error("[API] clear failed:", error);
    return NextResponse.json({ error: "Failed to clear usage data" }, { status: 500 });
  }
}
```

**API-level error states:**
- Invalid months param → 400 with descriptive message
- DB error during query → 500 with generic error message
- No data to clear → return 0 deletedRows (graceful)

---

### 4. Frontend: Data Summary Card — `src/app/(dashboard)/dashboard/profile/components/DataSummaryCard.js` (NEW)

A new component directory should be created:
`src/app/(dashboard)/dashboard/profile/components/`

This follows the pattern already used by usage page at `src/app/(dashboard)/dashboard/usage/components/`.

#### Component Structure

```jsx
"use client";

import { useState, useEffect } from "react";
import { Card } from "@/shared/components";
import { formatBytes } from "@/shared/utils/format";  // see note below

export default function DataSummaryCard() {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch("/api/usage/data-summary")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load");
        return res.json();
      })
      .then(setSummary)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <Card>...skeleton...</Card>;
  }

  if (error) {
    return <Card>...error state...</Card>;
  }

  return (
    <Card title="Data Summary" icon="storage">
      {/* Grid of 4 stats */}
      <div className="grid grid-cols-2 gap-4">
        <Stat label="Months Tracked" value={summary.totalMonths} icon="calendar_month" />
        <Stat label="Total Requests" value={summary.totalRequests.toLocaleString()} icon="swap_vert" />
        <Stat label="Total Tokens" value={summary.totalTokens.toLocaleString()} icon="token" />
        <Stat label="Database Size" value={formatBytes(summary.dbFileSize)} icon="database" />
      </div>
    </Card>
  );
}

function Stat({ label, value, icon }) {
  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-bg border border-border-subtle">
      <div className="p-2 rounded-lg bg-primary/10 text-primary">
        <span className="material-symbols-outlined text-[18px]">{icon}</span>
      </div>
      <div className="min-w-0">
        <p className="text-xs text-text-muted">{label}</p>
        <p className="font-semibold text-text-main truncate">{value}</p>
      </div>
    </div>
  );
}
```

**States:**
- **Loading:** Show a skeleton/pulse placeholder inside a card (use existing `CardSkeleton` pattern or simple pulse divs)
- **Empty:** If no data exists (totalRequests = 0), still show zeros gracefully — "No usage data yet"
- **Error:** Show a muted error message with a retry button
- **Success:** Show 4 stat boxes in a 2x2 grid

**Helper needed:** A `formatBytes` utility. Add to `src/shared/utils/format.js` (create if not exists) or inline:
```javascript
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "Unknown";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(1)} ${units[i]}`;
}
```

---

### 5. Frontend: Data Management Section — `src/app/(dashboard)/dashboard/profile/components/DataManagementSection.js` (NEW)

This is the main interactive component with retention selector, preview info, and clear button.

#### Component Architecture

```
DataManagementSection
├── Card wrapper with "Data Management" header
│   └── Collapsible toggle (expand_more/expand_less icon, like OIDC section) ← COLLAPSIBLE!
├── [Collapsed content]
│   ├── Retention Selector (Select component, inline Label)
│   ├── Info line: "Oldest record: YYYY-MM-DD  |  X months of data tracked"
│   ├── Preview line (conditional): "X rows will be deleted (YYYY-MM-DD to YYYY-MM-DD)"
│   ├── "Clear Old Data" Button (danger variant, disabled when Keep All selected)
│   └── ConfirmModal (confirmation popup)
│       ├── Title: "Clear Usage Data?"
│       ├── Message: "This will permanently delete [N] rows from [date] to [date].
│       │   This action cannot be undone."
│       ├── confirmText: "Yes, Delete [N] Rows" (danger variant)
│       └── cancelText: "Cancel"
```

The section starts **collapsed** by default, matching the OIDC pattern. The header button toggles visibility.

#### Toast After Success

Format: `"Deleted 5,231 records (before 2025-12-13)"` — rows removed + cutoff date, not the full date range.

Include a secondary message telling the user to **hard-refresh (F5/Cmd+R)** the page to clear in-memory caches on the usage page:
```javascript
title: "Data Cleared — Please Refresh"
message: "Deleted 5,231 records (before 2025-12-13). Hard refresh (F5/Cmd+R) to update usage charts."
```

#### State Machine & Logic

```
States: idle → preview-loading → preview-ready → confirm-open → deleting → done
Errors can interrupt at: preview-loading, deleting
```

**Detailed flow:**

1. **Mount:** Load `getOldestRecordDate()` and `getDataSummary()` to display initial info
   - Since the profile page already fetches `/api/settings` on mount, we either fetch alongside it or create a small combined API
    - **Recommendation:** The DataManagementSection calls `GET /api/usage/clear?action=dry-run&months=X` once the user selects a month value (not on mount for the full summary — use DataSummaryCard for that)

2. **Retention selector changes:**
   - If "Keep All" → disable clear button, hide preview
   - If 1/3/6/12 → enable clear button
   - Debounce: immediately fetch preview when selection changes (not on mount — wait for user interaction)

3. **User clicks "Clear Old Data":**
   - Show ConfirmModal with row count and date range from the last fetched preview
   - Modal has explicit "Yes, Delete N Rows" button (danger variant, red)
   - Loading state on confirm button while deletion is in progress

4. **After successful deletion:**
   - Show success toast: "Deleted [N] usage records"
   - Refresh the DataSummaryCard (lift state or use a refetch trigger)
   - Reset retention selector to "Keep All"
   - Hide preview info

5. **Error handling:**
   - Preview fetch fails → show error message inline, retry on next selection change
   - Deletion fails → show error toast, re-enable the confirm button (don't close modal)
   - Network error during deletion → error toast with "Failed to clear data. Please try again."

```jsx
export default function DataManagementSection({ onDataCleared }) {
  const [retentionMonths, setRetentionMonths] = useState("all");
  const [oldestDate, setOldestDate] = useState(null);
  const [totalMonths, setTotalMonths] = useState(0);
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [previewError, setPreviewError] = useState(null);

  const isKeepAll = retentionMonths === "all";

  // Fetch preview when months selection changes (not on mount)
  useEffect(() => {
    if (isKeepAll) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
      fetch(`/api/usage/clear?action=dry-run&months=${retentionMonths}`)
      .then(r => r.json())
      .then(data => { setPreview(data); setOldestDate(data.oldestDate); setTotalMonths(data.totalMonths); })
      .catch(err => setPreviewError(err.message))
      .finally(() => setPreviewLoading(false));
  }, [retentionMonths]);

  const handleClear = async () => {
    setDeleting(true);
    try {
      const res = await fetch("/api/usage/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ months: retentionMonths }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to clear data");
      
      // Success — include cutoff date + hard-refresh prompt
      const cutoffDisplay = data.cutoffDate ? new Date(data.cutoffDate).toISOString().slice(0, 10) : "";
      useNotificationStore.getState().success(
        `Deleted ${data.deletedRows} records (before ${cutoffDisplay}). Hard refresh (F5/Cmd+R) to update usage charts.`,
        "Data Cleared — Please Refresh"
      );
      setConfirmOpen(false);
      setRetentionMonths("all");
      setPreview(null);
      onDataCleared?.(); // trigger parent to refetch summary
    } catch (err) {
      useNotificationStore.getState().error(err.message, "Clear Failed");
    } finally {
      setDeleting(false);
    }
  };

  const handleRetentionChange = (e) => setRetentionMonths(e.target.value);

  // ...render
}
```

#### Confirmation Modal (inline within DataManagementSection)

Use the existing `<ConfirmModal>` from `@/shared/components` for simplicity. However, the current `ConfirmModal` only shows a simple `message` string prop — we need to show structured info (row count, date range, warning). Options:

**Option A (Recommended):** Use the base `<Modal>` component instead of `<ConfirmModal>` to have full control over the content. This gives us a bulleted list of facts and a prominent warning.

```jsx
<Modal
  isOpen={confirmOpen}
  onClose={() => !deleting && setConfirmOpen(false)}
  title="Clear Usage Data?"
  size="sm"
  footer={
    <>
      <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={deleting}>
        Cancel
      </Button>
      <Button variant="danger" onClick={handleClear} loading={deleting}>
        Yes, Delete {preview?.preview?.historyCount?.toLocaleString() || ""} Rows
      </Button>
    </>
  }
>
  <div className="flex flex-col gap-3 text-sm">
    <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
      <span className="material-symbols-outlined text-red-500 text-[18px]">warning</span>
      <p className="text-red-600 dark:text-red-400 font-medium">
        This action cannot be undone.
      </p>
    </div>
    <ul className="space-y-2 text-text-muted">
      <li><strong>Rows to delete:</strong> {preview?.preview?.historyCount?.toLocaleString() || 0}</li>
      {preview?.preview?.dateRange?.from && (
        <li><strong>Date range:</strong> {preview.preview.dateRange.from.slice(0, 10)} to {preview.preview.dateRange.to.slice(0, 10)}</li>
      )}
      <li><strong>All data older than {retentionMonths} month{retentionMonths > 1 ? "s" : ""}</strong> will be permanently removed.</li>
    </ul>
  </div>
</Modal>
```

**Option B:** Extend `ConfirmModal` to accept `children` alongside `message` (lower priority).

---

### 6. Integration into Profile Page

**File:** `src/app/(dashboard)/dashboard/profile/page.js`

**Changes:**

1. Import the two new components at the top:
```javascript
import DataSummaryCard from "./components/DataSummaryCard";
import DataManagementSection from "./components/DataManagementSection";
```

2. Add a `refreshKey` state variable to trigger DataSummaryCard refetch after data clearing:
```javascript
const [refreshKey, setRefreshKey] = useState(0);
const handleDataCleared = () => setRefreshKey((k) => k + 1);
```

3. Insert into the render tree. Best placement:
   - **DataSummaryCard:** After the existing "Local Mode" card (or at the top of the second column or between "Local Mode" and "Language")
   - **DataManagementSection:** Before the "Account actions" (Shutdown/Logout buttons) section

```jsx
{/* Data Summary */}
<DataSummaryCard key={refreshKey} />

{/* Data Management */}
<DataManagementSection onDataCleared={handleDataCleared} />
```

**Placement reasoning:**
- Data Summary at top gives immediate visibility without scrolling
- Data Management before Shutdown/Logout makes it part of the "maintenance" area of settings
- `key={refreshKey}` forces DataSummaryCard to re-mount and re-fetch after deletion

---

### 7. File System Changes Summary

| Action | File Path |
|--------|-----------|
| **NEW** | `src/app/(dashboard)/dashboard/profile/components/` (directory) |
| **NEW** | `src/app/(dashboard)/dashboard/profile/components/DataSummaryCard.js` |
| **NEW** | `src/app/(dashboard)/dashboard/profile/components/DataManagementSection.js` |
| **NEW** | `src/app/api/usage/data-summary/route.js` |
| **NEW** | `src/app/api/usage/clear/route.js` |
| **MODIFY** | `src/lib/db/repos/usageRepo.js` (append 4 new functions) |
| **MODIFY** | `src/app/(dashboard)/dashboard/profile/page.js` (import + mount components) |

---

### 8. Database Queries Reference

| Purpose | Query |
|---------|-------|
| Total rows | `SELECT COUNT(*) as c FROM usageHistory` |
| Total tokens | `SELECT COALESCE(SUM(promptTokens), 0) + COALESCE(SUM(completionTokens), 0) as t FROM usageHistory` |
| Distinct months | `SELECT DISTINCT substr(timestamp, 1, 7) as ym FROM usageHistory ORDER BY ym` |
| Oldest date | `SELECT MIN(timestamp) as ts FROM usageHistory` |
| Preview count | `SELECT COUNT(*) as c FROM usageHistory WHERE timestamp < ?` |
| Preview range | `SELECT MIN(timestamp) as min, MAX(timestamp) as max FROM usageHistory WHERE timestamp < ?` |
| Delete history | `DELETE FROM usageHistory WHERE timestamp < ?` |
| Delete daily | `DELETE FROM usageDaily WHERE dateKey < ?` |
| Delete request details | `DELETE FROM requestDetails WHERE timestamp < ?` |

---

### 9. Testing Notes

**Manual test scenarios:**

1. **Empty DB:** Launch fresh 9router with no usage data → data summary card shows zeros, data management shows "No data" or disabled state
2. **Summary display:** After some requests, verify months tracked, request count, and token counts are accurate
3. **File size:** Verify DB file size shows a plausible value (not 0, not null)
4. **Preview accuracy:** 
   - Select 1 month → verify the preview date range and row count match expectations
   - There should be a server-side check that the cutoff date is valid
5. **Actual deletion:**
   - Select retention period, confirm, check success toast
   - Refresh page → verify data summary updated
   - Verify usage history page no longer shows deleted data
6. **Edge — Keep All selected:** Clear button should be disabled, no preview shown
7. **Edge — Rapid double-click:** The confirm button has `loading` state and `disabled` during deletion — no accidental double-delete
8. **Edge — No data to delete:** If all data is within the retention window, preview shows 0 rows, deletion succeeds with 0 rows

**Edge cases to verify:**
- Deleting after all data is already deleted (should succeed with 0 rows)
- Very large deletion sets (100k+ rows) — SQLite DELETE in a transaction is fine but might take a moment — loading spinner on confirm button handles this
- DB file size after deletion should decrease (verify on disk)

**What NOT to test:**
- Race conditions from concurrent deletes (single-user local app)
- Partial deletion (transaction ensures atomicity)
- Other data tables (usageHistory and usageDaily only)

---

### 10. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| User deletes data they need | Data loss | Confirmation popup with explicit row count + warning + "cannot be undone" message; retention period (not "delete all") preserves recent data |
| Transaction fails mid-way | Inconsistent state | SQLite transaction ensures both tables stay consistent; `db.transaction()` rolls back on error |
| Large DELETE blocks DB | Brief UI freeze | SQLite DELETE is fast with indexed `timestamp` column; for 100k+ rows within a transaction, it completes in milliseconds |
| `fs.statSync` fails | null file size | Caught gracefully, displayed as "Unknown" |
| API returns stale preview | Row count mismatch | Preview is fetched immediately before showing confirmation; the gap between preview and delete is small (user reads the modal) |

---

### 11. Open Questions / Assumptions

**Assumptions:**
- `retentionMonths` is always an integer: 1, 3, 6, or 12 (or "all")
- The `useNotificationStore` is a global zustand store — can be called via `getState()` from any component
- Profile page uses `"use client"` — new components also use `"use client"`
- Data summary and management are scoped ONLY to `usageHistory` and `usageDaily` tables — no other data is affected
- DB file path accessible server-side only — file size fetched via API, not client-side

**Resolved Questions:**
1. **Placement:** On the existing profile/settings page (`/dashboard/profile`) ✅
2. **Retention options:** Retention-only (1, 3, 6, 12 months + Keep All). No Delete Everything. ✅
3. **Persistence:** Manual-only. Each clear is a one-time explicit action. ✅
4. **Dry-run endpoint:** Separate GET endpoint with `action=dry-run` that returns preview without any DB writes. ✅

---

### 12. Performance Considerations

- `COUNT(*)` and `SUM()` on usageHistory with an index on `timestamp` is O(log N) for a single value query — fine for any practical dataset size
- `DELETE` with a `WHERE timestamp < ?` uses the existing `idx_uh_ts` index for fast row location
- No new indexes needed
- No migration needed (schema unchanged)
