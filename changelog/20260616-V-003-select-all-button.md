# Task: V-003 — Select All Button in ModelSelectModal for ComboFormModal

**Date:** 20260616
**Ticket:** V-003
**Repository:** /Users/pid-alvian/Documents/alvian/9router
**Remote:** git@github.com:vianhanif/9router.git
**Base Branch:** master
**Worktree:** `.worktrees/V-003-select-all/`

---

## Task Overview

### What is Changing
Add a "Select All" button in the `ModelSelectModal` component that, when clicked, adds all available models (excluding already-selected and invalid entries) to a combo chain in one action.

### Why it is Needed
Users building combo chains with many models need a faster way to bulk-select rather than clicking each model individually. This is especially valuable during combo creation when exploring provider/model coverage.

### Success Criteria
- "Select All" button visible only in combo context (prop-gated)
- Button adds all eligible models at once via sequential `onSelect` calls
- Already-selected models are not re-added
- Placeholder models (`isPlaceholder: true`) are excluded
- Combo names (LLM-only items in the Combos section) are not added to the model chain
- Button disabled/hidden when no eligible models remain
- No regression for other consumers of `ModelSelectModal` (CLI tools, etc.)

---

## Scope Table

| # | Scope | Target Branch | File(s) | Complexity | Estimate |
|---|-------|---------------|---------|------------|----------|
| 1 | Add `showSelectAll` prop + UI to `ModelSelectModal` | `feature/V-003-combos-import-export` | `src/shared/components/ModelSelectModal.js` | Low | 30min |
| 2 | Pass `showSelectAll` from `ComboFormModal` | `feature/V-003-combos-import-export` | `src/shared/components/ComboFormModal.js` | Low | 5min |

---

## Implementation Plan

### 1. Approach: Prop-gated inside ModelSelectModal

**Decision:** Add `showSelectAll` boolean prop to `ModelSelectModal`, not a wrapper in `ComboFormModal`.

**Rationale:**
- `groupedModels` is computed internally — the Select All logic needs access to it
- Wrapping `ModelSelectModal` inside `ComboFormModal` to inject a button above/below would require `ModelSelectModal` to expose `groupedModels` or become a controlled render prop, adding coupling
- Prop-gated approach keeps all Select All logic self-contained in `ModelSelectModal`
- Other consumers (CLI tools) are unaffected — `showSelectAll` defaults to `false`

### 2. Files to Modify

| File | Change |
|------|--------|
| `src/shared/components/ModelSelectModal.js` | Add `showSelectAll` prop, compute eligible models, render "Select All" button |
| `src/shared/components/ComboFormModal.js` | Pass `showSelectAll={true}` to `ModelSelectModal` |

### 3. UI Placement

In `ModelSelectModal.js`, add the button as a **standalone row below the search bar**, between search and the model list (line 402 area):

```
[ Search bar                                              ]
[ Select All (5)                                          ]  ← new row
[ --- model groups start --- ]
```

**Styling:** `text-xs text-primary font-medium hover:underline flex items-center gap-1`
**Icon:** `select_all` material symbol

### 4. Logic: Collecting "All Models" Minus Exclusions

In `ModelSelectModal.js`, compute eligible models based on the **current filtered view** (search-aware):

```js
// Compute selectable models (used by Select All) — respects active search filter
const selectableModels = useMemo(() => {
  if (!showSelectAll) return [];
  const excluded = new Set([
    ...addedModelValues,               // already in combo chain
    ...combos.map(c => c.name),        // combo names — NOT model strings
  ]);
  const models = [];
  // Use filteredGroups (search-filtered) so Select All respects current search query
  Object.values(filteredGroups).forEach(group => {
    group.models.forEach(model => {
      // EXCLUDE: already added, placeholder, or a combo name
      if (excluded.has(model.value)) return;
      if (model.isPlaceholder) return;
      models.push(model);
    });
  });
  return models;
}, [showSelectAll, filteredGroups, addedModelValues, combos]);
```

**Note:** Uses `filteredGroups` (not `groupedModels`) — so Select All **only adds models visible in the current search view**. If search is empty, all models are included.

**Exclusions confirmed:**
- `addedModelValues` → prevents re-adding models already in the chain
- `combos.map(c => c.name)` → prevents adding combo names as model values (would be circular)
- `model.isPlaceholder` → `__placeholder__*` items are dashed-border edit hints, not real models

**What IS included:**
- Custom models (`model.isCustom: true`) — user-defined models via "Add Model"
- Provider-as-model items (`webSearch`/`webFetch` kinds) — `value === providerId`
- Passthrough model aliases — standard `${alias}/${modelId}` strings

### 5. Select All Handler

```js
const handleSelectAll = () => {
  selectableModels.forEach(model => {
    onSelect(model);
  });
};
```

Called once per model — `onSelect` in `ComboFormModal` does a duplicate check (`if (!models.includes(model.value))`) before appending, so safe to call even if some were added via search.

### 6. Button State

```jsx
<button
  onClick={handleSelectAll}
  disabled={selectableModels.length === 0}
  className={`ml-auto text-xs font-medium flex items-center gap-1 transition-colors
    ${selectableModels.length === 0
      ? "text-text-muted/40 cursor-not-allowed"
      : "text-primary hover:underline"
    }`}
>
  <span className="material-symbols-outlined text-[14px]">select_all</span>
  Select All
  {selectableModels.length > 0 && (
    <span className="text-[10px] text-text-muted">({selectableModels.length})</span>
  )}
</button>
```

### 7. Guardrails for Other Consumers

- `showSelectAll` defaults to `undefined` / `false` — zero change to all existing consumers
- No behavior change unless `showSelectAll` is explicitly passed as `true`
- Combo names are excluded in Select All logic regardless of consumer
- `kindFilter` still works — if `kindFilter` is set, only models matching that kind appear in `groupedModels`, so Select All respects it automatically

---

## Assumptions & Open Questions

1. **After Select All, does the modal stay open?** Yes — `closeOnSelect` is `false` in ComboFormModal, so the modal stays open and shows updated selected state.
2. **Are there any performance concerns?** `selectableModels` is memoized; Select All calls `onSelect` in a loop (sync, no re-render batching needed since `setModels` in ComboFormModal batches naturally in React). For extreme cases (100+ models), this is fine.
3. **What if a provider has 0 models (only placeholder)?** Placeholder is excluded → that provider contributes 0 to Select All. Button count reflects actual selectable models only.

---

## Round 1 Resolution
- **Placement:** Below search bar (not in info bar)
- **Search behavior:** Respects filter — uses `filteredGroups` not `groupedModels`
- **Naming:** "Select All"

## Round 2 Resolution
- **Batching:** Add `onSelectAll` prop (array callback) — ComboFormModal handles single `setModels` call
- **Toggle:** "Select All" ↔ "Deselect All" — toggles when all visible models are selected
- **Search field:** Stays as-is after select/deselect

---

## Updated Implementation Plan

### Updated Prop Design for `ModelSelectModal`

Replace per-model `onSelect` loop with **`onSelectAll`** prop (batch callback):

```js
// ModelSelectModal.js — new props
onSelectAll: PropTypes.func,   // called with { models: [...], mode: 'add' | 'remove' }

// Compute state
const allSelected = selectableModels.length === 0;
const hasAnySelectable = selectableModels.length > 0 || hasAnyAddedInFiltered;
```

### Updated Select All Logic

```js
// Models in the filtered view that are NOT yet added
const unselectedInFilter = useMemo(() => {
  if (!showSelectAll) return [];
  const excluded = new Set([
    ...addedModelValues,
    ...combos.map(c => c.name),
  ]);
  const models = [];
  Object.values(filteredGroups).forEach(group => {
    group.models.forEach(m => {
      if (!excluded.has(m.value) && !m.isPlaceholder) models.push(m);
    });
  });
  return models;
}, [showSelectAll, filteredGroups, addedModelValues, combos]);

// Models in the filtered view that ARE already added
const addedInFilter = useMemo(() => {
  if (!showSelectAll) return [];
  const all = Object.values(filteredGroups).flatMap(g => g.models);
  return all.filter(m => addedModelValues.includes(m.value));
}, [showSelectAll, filteredGroups, addedModelValues]);

const allSelected = unselectedInFilter.length === 0 && addedInFilter.length > 0;
const hasAnySelectable = unselectedInFilter.length > 0 || allSelected;

const handleSelectAll = () => {
  if (allSelected && onSelectAll) {
    onSelectAll({ models: addedInFilter, mode: 'remove' });
  } else if (onSelectAll) {
    onSelectAll({ models: unselectedInFilter, mode: 'add' });
  }
};
```

### ComboFormModal Integration

```js
// New handler in ComboFormModal
const handleSelectAll = (payload) => {
  const { models, mode } = payload;
  const values = models.map(m => m.value);
  if (mode === 'add') {
    // Add only new values
    setModels(prev => [...prev, ...values.filter(v => !prev.includes(v))]);
  } else {
    // Remove all values in payload
    setModels(prev => prev.filter(v => !values.includes(v)));
  }
};
```

### Button UI (Toggle)

```jsx
{hasAnySelectable && (
  <button
    onClick={handleSelectAll}
    className="w-full text-left text-xs font-medium flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-primary/30 hover:border-primary/60 transition-colors"
  >
    <span className="material-symbols-outlined text-[14px] text-primary">
      {allSelected ? 'deselect' : 'select_all'}
    </span>
    <span className="text-primary">{allSelected ? 'Deselect All' : 'Select All'}</span>
    <span className="ml-auto text-[10px] text-text-muted">
      ({allSelected ? addedInFilter.length : unselectedInFilter.length})
    </span>
  </button>
)}
```

---

## Round 3 Resolution
- **Deselect scope:** Only visible (filtered) — consistent with Select All behavior
- **Button style:** Full-width row
- **kindFilter:** LLM-only — `showSelectAll` button hidden when `kindFilter` is set (since combos are LLM-only, this is naturally satisfied; `ComboFormModal` uses `kindFilter={null}`)

---

## Final Implementation Plan

### Files to Modify

| File | Change | Scope |
|------|--------|-------|
| `src/shared/components/ModelSelectModal.js` | Add `showSelectAll` prop, `onSelectAll` prop, computed `unselectedInFilter` + `addedInFilter` memos, button UI | Scope 1 |
| `src/shared/components/ComboFormModal.js` | Pass `showSelectAll={true}` + `onSelectAll={handleSelectAll}` | Scope 2 |

---

## ModelSelectModal.js — Spec

### New Props
```js
showSelectAll: PropTypes.bool,      // default false — only ComboFormModal passes true
onSelectAll: PropTypes.func,        // (payload: { models, mode: 'add'|'remove' }) => void
```

### Guard: Hidden when `kindFilter` is set
```js
const showSelectAllButton = showSelectAll && !kindFilter;
```

### Computed memos (inserted after `filteredGroups` memo)
```js
// Eligible unselected models in current filtered view
const unselectedInFilter = useMemo(() => {
  if (!showSelectAllButton) return [];
  const excluded = new Set([...addedModelValues, ...combos.map(c => c.name)]);
  return Object.values(filteredGroups)
    .flatMap(g => g.models)
    .filter(m => !excluded.has(m.value) && !m.isPlaceholder);
}, [showSelectAllButton, filteredGroups, addedModelValues, combos]);

// Already-added models in current filtered view (for Deselect All)
const addedInFilter = useMemo(() => {
  if (!showSelectAllButton) return [];
  return Object.values(filteredGroups)
    .flatMap(g => g.models)
    .filter(m => addedModelValues.includes(m.value) && !m.isPlaceholder);
}, [showSelectAllButton, filteredGroups, addedModelValues]);

const allFilteredSelected = unselectedInFilter.length === 0 && addedInFilter.length > 0;
const hasSelectAllButton = showSelectAllButton && (unselectedInFilter.length > 0 || allFilteredSelected);
```

### Handler
```js
const handleSelectAll = () => {
  if (!onSelectAll) return;
  if (allFilteredSelected) {
    onSelectAll({ models: addedInFilter, mode: 'remove' });
  } else {
    onSelectAll({ models: unselectedInFilter, mode: 'add' });
  }
};
```

### JSX (inserted between search bar and model list)
```jsx
{hasSelectAllButton && (
  <div className="mb-3">
    <button
      onClick={handleSelectAll}
      className="w-full px-2.5 py-1.5 rounded-lg border border-primary/30 hover:border-primary/60 bg-primary/5 hover:bg-primary/10 transition-colors flex items-center gap-1.5 text-xs font-medium text-primary"
    >
      <span className="material-symbols-outlined text-[14px]">
        {allFilteredSelected ? 'deselect' : 'select_all'}
      </span>
      {allFilteredSelected ? 'Deselect All' : 'Select All'}
      <span className="ml-auto text-[10px] text-text-muted">
        ({allFilteredSelected ? addedInFilter.length : unselectedInFilter.length})
      </span>
    </button>
  </div>
)}
```

---

## ComboFormModal.js — Spec

### New handler
```js
const handleSelectAll = ({ models, mode }) => {
  const values = models.map(m => m.value);
  if (mode === 'add') {
    setModels(prev => [...prev, ...values.filter(v => !prev.includes(v))]);
  } else {
    setModels(prev => prev.filter(v => !values.includes(v)));
  }
};
```

### Updated `<ModelSelectModal>` usage (line 169)
```jsx
<ModelSelectModal
  isOpen={showModelSelect}
  onClose={() => setShowModelSelect(false)}
  onSelect={handleAddModel}
  onDeselect={handleDeselectModel}
  onSelectAll={handleSelectAll}       {/* NEW */}
  showSelectAll={true}                {/* NEW */}
  activeProviders={activeProviders}
  modelAliases={modelAliases}
  title="Add Model to Combo"
  kindFilter={kindFilter}
  addedModelValues={models}
  closeOnSelect={false}
/>
```

---

## Guardrails Summary

| Risk | Mitigation |
|------|-----------|
| Breaking CLI tool consumers | `showSelectAll` defaults `false` — no change to existing usages |
| Circular combos in chain | Combo names always excluded via `combos.map(c => c.name)` |
| Placeholder models in chain | Filtered by `m.isPlaceholder` |
| Non-LLM kindFilter edge case | `showSelectAllButton = showSelectAll && !kindFilter` |
| Duplicate models in chain | ComboFormModal `add` path: `values.filter(v => !prev.includes(v))` |
| Performance on large lists | All computed via `useMemo`; single `setModels` call per action |

---

## Worktree
- Path: `.worktrees/V-003-select-all/`
- Branch: `feature/V-003-combos-import-export`

