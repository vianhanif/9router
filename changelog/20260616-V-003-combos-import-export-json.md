### Task Overview

Add the ability to **export combos to a JSON file** and **import combos from a JSON file** (full replacement) via the dashboard combos page.

- **What**: Two new API endpoints (`GET /api/combos/export`, `POST /api/combos/import`) and corresponding UI buttons on the combos dashboard.
- **Why**: Provide bulk transfer/backup/restore capability for combos without manual per-combo recreation.
- **Success criteria**:
  1. Clicking "Export" downloads a JSON file containing all combos with their strategies (name, kind, models, round-robin flag).
  2. Clicking "Import" opens a file picker → reads JSON → shows a confirmation dialog → on confirm, replaces ALL combos with imported data.
  3. Import is transactional — if any combo fails, none are committed.
  4. Duplicate names in the import file cause the entire import to be rejected.
  5. Import generates fresh UUIDs and timestamps for each combo.
  6. Import restores round-robin strategy per combo via settings update.
  7. Import calls `resetComboRotation()` to reset all rotation counters.

---

### Scope Table

| # | Scope | Target Branch | Repository / Service | Complexity | Estimate |
|---|-------|---------------|----------------------|------------|----------|
| 1 | API: Export endpoint | `feature/V-003-combos-import-export-json` | 9router (Next.js) | Medium | ~25 min |
| 2 | API: Import endpoint | `feature/V-003-combos-import-export-json` | 9router (Next.js) | High | ~45 min |
| 3 | DB: add `deleteAllCombos` to combosRepo | `feature/V-003-combos-import-export-json` | 9router (Next.js) | Low | ~10 min |
| 4 | UI: Export/Import buttons + file picker + confirmation modal | `feature/V-003-combos-import-export-json` | 9router (Next.js) | Medium | ~40 min |

**Total estimate**: ~120 min (single scope, all changes on one branch)

---

### JSON Export Format

```json
{
  "version": 1,
  "exportedAt": "2025-06-16T12:00:00.000Z",
  "combos": [
    {
      "name": "my-combo",
      "kind": null,
      "models": ["kr/claude-sonnet-4.5", "ag/claude-sonnet-4-5"],
      "roundRobin": true
    }
  ]
}
```

Fields:
- `version` — schema version (integer, starts at 1)
- `exportedAt` — ISO timestamp of export (informational)
- `combos` — array of combo objects:
  - `name` (required, string, must match `/^[a-zA-Z0-9_.\-]+$/`)
  - `kind` (optional, string or null — must be one of: `null`, `"llm"`, `"webSearch"`, `"webFetch"`)
  - `models` (required, array of strings — defaults to `[]`)
  - `roundRobin` (optional, boolean — if `true`, sets `fallbackStrategy: "round-robin"` on import)

Fields NOT exported (generated on import): `id`, `createdAt`, `updatedAt`

---

### Implementation Plan

#### Step 1 — DB: Add `deleteAllCombos` to repository

**File**: `src/lib/db/repos/combosRepo.js`

Add function:
```js
export async function deleteAllCombos() {
  const db = await getAdapter();
  db.run(`DELETE FROM combos`);
}
```

Also verify that `stringifyJson` is imported for use in the import route.

---

#### Step 2 — Create export API route

**File**: `src/app/api/combos/export/route.js` (new)

Create a GET handler that:
1. Fetches all combos via `getCombos()`
2. Fetches settings via `getSettings()` to get `comboStrategies`
3. Maps each combo to export format, adding `roundRobin: true` if the combo has a round-robin strategy
4. Returns JSON with `Content-Disposition` header for download

```js
import { NextResponse } from "next/server";
import { getCombos } from "@/lib/localDb";
import { getSettings } from "@/lib/db/repos/settingsRepo";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [combos, settings] = await Promise.all([getCombos(), getSettings()]);
    const comboStrategies = settings.comboStrategies || {};
    const exportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      combos: combos.map((c) => ({
        name: c.name,
        kind: c.kind,
        models: c.models,
        roundRobin: comboStrategies[c.name]?.fallbackStrategy === "round-robin",
      })),
    };

    return new NextResponse(JSON.stringify(exportData, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="combos-export-${new Date().toISOString().split("T")[0]}.json"`,
      },
    });
  } catch (error) {
    console.log("Error exporting combos:", error);
    return NextResponse.json({ error: "Failed to export combos" }, { status: 500 });
  }
}
```

---

#### Step 3 — Create import API route

**File**: `src/app/api/combos/import/route.js` (new)

Create a POST handler that:
1. Accepts JSON body with `{ combos: [...] }`
2. **Validates**:
   - `combos` is a non-empty array (reject empty with error)
   - Each combo has a `name` (string, non-empty)
   - Each `name` matches `/^[a-zA-Z0-9_.\-]+$/`
   - Each `kind` is one of: null, `"llm"`, `"webSearch"`, `"webFetch"`
   - `models` is an array (if present)
   - `name` uniqueness within the file (no duplicates)
3. If validation fails → return 400 with specific error message
4. Wraps the delete+insert in a **transaction**
5. Deletes all existing combos
6. Inserts each combo with new UUIDs and timestamps
7. Builds `comboStrategies` map from `roundRobin` flags
8. Updates settings with the new `comboStrategies`
9. Calls `resetComboRotation()` to reset all rotation counters
10. Returns `{ success: true, imported: N }`

```js
import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "@/lib/db/driver";
import { parseJson, stringifyJson } from "@/lib/db/helpers/jsonCol";
import { resetComboRotation } from "open-sse/services/combo";

export const dynamic = "force-dynamic";

const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;
const VALID_KINDS = new Set([null, "llm", "webSearch", "webFetch"]);

export async function POST(request) {
  try {
    const body = await request.json();
    const { combos } = body;

    // Validate: combos must be a non-empty array
    if (!Array.isArray(combos) || combos.length === 0) {
      return NextResponse.json({ error: '"combos" must be a non-empty array' }, { status: 400 });
    }

    // Validate each combo entry
    const names = new Set();
    for (let i = 0; i < combos.length; i++) {
      const combo = combos[i];

      if (!combo.name || typeof combo.name !== "string" || !combo.name.trim()) {
        return NextResponse.json({ error: `Entry ${i}: "name" is required` }, { status: 400 });
      }

      if (!VALID_NAME_REGEX.test(combo.name)) {
        return NextResponse.json({ error: `Entry ${i}: name "${combo.name}" contains invalid characters` }, { status: 400 });
      }

      if (!VALID_KINDS.has(combo.kind ?? null)) {
        return NextResponse.json({ error: `Entry ${i}: "kind" must be one of: null, "llm", "webSearch", "webFetch"` }, { status: 400 });
      }

      if (combo.models !== undefined && !Array.isArray(combo.models)) {
        return NextResponse.json({ error: `Entry ${i}: "models" must be an array` }, { status: 400 });
      }

      if (names.has(combo.name)) {
        return NextResponse.json({ error: `Duplicate combo name "${combo.name}" found at entry ${i}` }, { status: 400 });
      }
      names.add(combo.name);
    }

    const db = await getAdapter();

    // Build round-robin strategies map
    const comboStrategies = {};
    for (const combo of combos) {
      if (combo.roundRobin === true) {
        comboStrategies[combo.name] = { fallbackStrategy: "round-robin" };
      }
    }

    // Single atomic transaction: delete all combos, insert new ones, update settings
    db.transaction(() => {
      db.run(`DELETE FROM combos`);
      const now = new Date().toISOString();
      for (const combo of combos) {
        const id = uuidv4();
        db.run(
          `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
          [id, combo.name, combo.kind || null, stringifyJson(combo.models || []), now, now]
        );
      }

      // Atomically update settings with round-robin strategies
      // (Uses direct SQL upsert to avoid nested transaction from updateSettings())
      const raw = db.get(`SELECT data FROM settings WHERE id = 1`);
      const settings = raw ? parseJson(raw.data, {}) : {};
      const newSettings = { ...settings, comboStrategies };
      db.run(
        `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
        [stringifyJson(newSettings)]
      );
    });

    // Reset in-memory rotation state
    resetComboRotation();

    return NextResponse.json({ success: true, imported: combos.length });
  } catch (error) {
    console.log("Error importing combos:", error);
    return NextResponse.json({ error: "Failed to import combos" }, { status: 500 });
  }
}
```

---

#### Step 4 — Re-export `deleteAllCombos` in localDb shim

**File**: `src/lib/localDb.js`

Add re-export:
```js
export { deleteAllCombos } from "./db/repos/combosRepo";
```

---

#### Step 5 — Dashboard UI: Add Export/Import buttons

**File**: `src/app/(dashboard)/dashboard/combos/page.js`

Changes:
1. Add state:
   - `showImportModal` (bool)
   - `importFileData` (object: `{ fileName, comboCount }`)
   - `importing` (bool)
   - `exporting` (bool)

2. Add header buttons (grouped with "Create Combo"):
   ```jsx
   <div className="flex items-center gap-2">
     <Button icon="download" onClick={handleExport} disabled={exporting} size="sm" variant="outline">
       Export
     </Button>
     <Button icon="upload" onClick={handleImportClick} disabled={importing} size="sm" variant="outline">
       Import
     </Button>
     <Button icon="add" onClick={() => setShowCreateModal(true)} className="w-full sm:w-auto">
       Create Combo
     </Button>
   </div>
   ```

3. Export handler:
   ```js
   const handleExport = () => {
     const a = document.createElement("a");
     a.href = "/api/combos/export";
     a.download = `combos-export-${new Date().toISOString().split("T")[0]}.json`;
     a.click();
   };
   ```

4. Import handler:
   - Opens file picker via hidden `<input type="file" accept=".json">`
   - Reads file, parses JSON
   - Validates basic structure: `{ combos: [...] }` is present and is an array
   - Sets `importFileData` and shows `ConfirmModal`
   - On confirm, POSTs to `/api/combos/import` with the full JSON data
   - On success: reloads combos via `fetchData()`
   - On error: shows error message

5. Add hidden file input ref (or create dynamically):
   ```js
   const fileInputRef = useRef(null);
   ```

6. Import confirm modal: Reuse existing `ConfirmModal` with title "Import Combos", message `"This will replace ALL ${combos.length} existing combos with ${importFileData.comboCount} combos from ${importFileData.fileName}."`

7. Add a small note below the Import button area or in the modal:
   > "Make sure providers referenced in the imported combos are already connected. Models from unconnected providers will not work."

---

### Files to Create / Modify

| Action | File | Description |
|--------|------|-------------|
| **Modify** | `src/lib/db/repos/combosRepo.js` | Add `deleteAllCombos()` function |
| **Modify** | `src/lib/localDb.js` | Re-export `deleteAllCombos` |
| **Create** | `src/app/api/combos/export/route.js` | New API — export combos as JSON (includes round-robin strategy from settings) |
| **Create** | `src/app/api/combos/import/route.js` | New API — import combos from JSON (full replace, transactional, updates settings) |
| **Modify** | `src/app/(dashboard)/dashboard/combos/page.js` | Add Export/Import buttons, file picker, confirm modal, connection note |

---

### Validation Summary

| Scenario | Expected Behavior |
|----------|------------------|
| Export with 0 combos | Returns `{ version, exportedAt, combos: [] }` — valid JSON with empty array |
| Export with N combos | All combos exported with name, kind, models, roundRobin flag |
| Import valid JSON (N combos) | All existing combos deleted, N new combos inserted, settings updated, rotations reset, returns `{ success: true, imported: N }` |
| Import empty combos array | 400: `"combos" must be a non-empty array` |
| Import with missing `combos` key | 400: `"combos" must be a non-empty array` |
| Import with missing name | 400: `Entry {i}: "name" is required` |
| Import with invalid name characters | 400: `Entry {i}: name "..." contains invalid characters` |
| Import with invalid kind | 400: `Entry {i}: "kind" must be one of: null, "llm", "webSearch", "webFetch"` |
| Import with invalid models | 400: `Entry {i}: "models" must be an array` |
| Import with duplicate names in file | 400: `Duplicate combo name "..." found at entry {i}` |
| Import invalid JSON (parse error) | 400: handled by UI before reaching API |
| Transaction failure | If DB insert fails mid-import, the transaction rollback prevents partial import |
| Transaction failure | Full atomicity: combos + settings in same transaction — any failure rolls back everything |

---

### Risks / Assumptions

- **Full atomicity**: Combo delete + insert + settings update all run in a single `db.transaction()`. Settings update uses direct SQL upsert (bypassing `updateSettings()`) to avoid nested transaction issues. Any failure rolls back the entire import.
- **Settings merge is safe**: The `ON CONFLICT DO UPDATE` preserves all existing settings keys; only `comboStrategies` is replaced. Confirmed identical to `settingsRepo.updateSettings()` behavior.
- **`getAdapter()` returns the same instance** within the same request — confirmed by existing usage pattern
- **`resetComboRotation()` is synchronous** — it resets in-memory state, not DB state
- **No concurrent import/export issues** — the app is single-user/single-process
- **Import file is not streamed** — read fully into memory; acceptable since combos are expected to be small
- **Backward compatibility**: The `roundRobin` field in the JSON is optional on import (defaults to false if not present). Old exports without this field will still work — all imported combos will have no round-robin strategy by default.
- **`updateSettings` uses a transaction** that reads the current settings and merges — this means the comboStrategies update is also atomic and won't corrupt other settings.
