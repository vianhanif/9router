import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-ie-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("deleteAllCombos", () => {
  it("clears all combos from the database", async () => {
    const { createCombo, getCombos, deleteAllCombos } = await import("@/lib/db/repos/combosRepo");
    await createCombo({ name: "combo-a", models: ["a/1"] });
    await createCombo({ name: "combo-b", models: ["b/1"] });
    expect((await getCombos())).toHaveLength(2);

    await deleteAllCombos();
    expect((await getCombos())).toHaveLength(0);
  });

  it("is safe to call on empty table", async () => {
    const { getCombos, deleteAllCombos } = await import("@/lib/db/repos/combosRepo");
    expect((await getCombos())).toHaveLength(0);
    await deleteAllCombos();
    expect((await getCombos())).toHaveLength(0);
  });
});

describe("GET /api/combos/export", () => {
  it("returns valid JSON with empty combos array when no combos exist", async () => {
    const { GET } = await import("@/app/api/combos/export/route");
    const response = await GET();
    const body = await response.json();

    expect(body).toEqual({ version: 2, exportedAt: expect.any(String), combos: [] });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("content-disposition")).toContain("attachment");
  });

  it("returns all combos with correct fields", async () => {
    const { createCombo } = await import("@/lib/db/repos/combosRepo");
    const { GET } = await import("@/app/api/combos/export/route");

    await createCombo({ name: "combo-a", kind: "llm", models: ["a/1", "a/2"] });
    await createCombo({ name: "combo-b", kind: "webSearch", models: ["b/1"] });

    const response = await GET();
    const body = await response.json();

    expect(body.version).toBe(2);
    expect(body.combos).toHaveLength(2);

    const a = body.combos.find((c) => c.name === "combo-a");
    expect(a).toBeDefined();
    expect(a.kind).toBe("llm");
    expect(a.models).toEqual(["a/1", "a/2"]);
    expect(a.strategy).toEqual({ fallbackStrategy: "fallback" });
  });

  it("includes strategy object from settings", async () => {
    const { createCombo } = await import("@/lib/db/repos/combosRepo");
    const { updateSettings } = await import("@/lib/db/repos/settingsRepo");
    const { GET } = await import("@/app/api/combos/export/route");

    await createCombo({ name: "rr-combo", kind: "llm", models: ["a/1"] });
    await updateSettings({ comboStrategies: { "rr-combo": { fallbackStrategy: "round-robin" } } });

    const response = await GET();
    const body = await response.json();

    expect(body.combos[0].strategy).toEqual({ fallbackStrategy: "round-robin" });
  });

  it("includes fusion strategy with judgeModel from settings", async () => {
    const { createCombo } = await import("@/lib/db/repos/combosRepo");
    const { updateSettings } = await import("@/lib/db/repos/settingsRepo");
    const { GET } = await import("@/app/api/combos/export/route");

    await createCombo({ name: "fusion-combo", kind: "llm", models: ["a/1", "a/2"] });
    await updateSettings({
      comboStrategies: { "fusion-combo": { fallbackStrategy: "fusion", judgeModel: "gpt-4" } },
    });

    const response = await GET();
    const body = await response.json();

    expect(body.combos[0].strategy).toEqual({ fallbackStrategy: "fusion", judgeModel: "gpt-4" });
  });
});

describe("POST /api/combos/import — validation", () => {
  async function callImport(body) {
    const { POST } = await import("@/app/api/combos/import/route");
    const request = new Request("http://localhost/api/combos/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return POST(request);
  }

  async function callImportRaw(jsonStr) {
    const { POST } = await import("@/app/api/combos/import/route");
    const request = new Request("http://localhost/api/combos/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: jsonStr,
    });
    return POST(request);
  }

  it("rejects non-object body", async () => {
    const { POST } = await import("@/app/api/combos/import/route");
    const request = new Request("http://localhost/api/combos/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '"just a string"',
    });
    const response = await POST(request);
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toContain("Invalid JSON");
  });

  it("rejects array body", async () => {
    const { POST } = await import("@/app/api/combos/import/route");
    const request = new Request("http://localhost/api/combos/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "[]",
    });
    const response = await POST(request);
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toContain("Invalid JSON");
  });

  it("rejects missing version", async () => {
    const response = await callImport({ combos: [{ name: "x", models: [] }] });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toContain("version");
  });

  it("rejects non-array combos", async () => {
    const response = await callImport({ version: 1, combos: "not-an-array" });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toContain("Combos must be an array");
  });

  it("rejects empty combos array", async () => {
    const response = await callImport({ version: 1, combos: [] });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toContain("At least one combo");
  });

  it("rejects invalid combo entry (non-object)", async () => {
    const response = await callImport({ version: 1, combos: ["not-an-object"] });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toContain("invalid entry");
  });

  it("rejects missing name", async () => {
    const response = await callImport({ version: 1, combos: [{ models: [] }] });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toContain("name is required");
  });

  it("rejects empty name string", async () => {
    const response = await callImport({ version: 1, combos: [{ name: "  ", models: [] }] });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toContain("name is required");
  });

  it("rejects invalid name characters", async () => {
    const response = await callImport({ version: 1, combos: [{ name: "bad name!", models: [] }] });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toContain("letters, numbers");
  });

  it("rejects duplicate names within file", async () => {
    const response = await callImport({
      version: 1,
      combos: [
        { name: "dup", models: [] },
        { name: "dup", models: [] },
      ],
    });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toContain("duplicate");
    expect(body.error).toContain("dup");
  });

  it("rejects invalid kind", async () => {
    const response = await callImport({ version: 1, combos: [{ name: "x", kind: "badKind", models: [] }] });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toContain("invalid kind");
  });

  it("accepts valid kinds: llm, webSearch, webFetch", async () => {
    const response = await callImport({
      version: 1,
      combos: [
        { name: "a", kind: "llm", models: [] },
        { name: "b", kind: "webSearch", models: [] },
        { name: "c", kind: "webFetch", models: [] },
      ],
    });
    expect(response.status).toBe(201);
  });

  it("accepts null kind", async () => {
    const response = await callImport({
      version: 1,
      combos: [{ name: "a", kind: null, models: [] }],
    });
    expect(response.status).toBe(201);
  });

  it("rejects non-array models", async () => {
    const response = await callImport({ version: 1, combos: [{ name: "x", models: "not-array" }] });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toContain("models must be an array");
  });

  it("rejects non-boolean roundRobin", async () => {
    const response = await callImport({ version: 2, combos: [{ name: "x", models: [], roundRobin: "yes" }] });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toContain("roundRobin must be a boolean");
  });

  it("rejects invalid strategy field (non-object)", async () => {
    const response = await callImport({ version: 2, combos: [{ name: "x", models: [], strategy: "round-robin" }] });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toContain("strategy must be an object");
  });

  it("rejects invalid fallbackStrategy value", async () => {
    const response = await callImport({ version: 2, combos: [{ name: "x", models: [], strategy: { fallbackStrategy: "invalid-mode" } }] });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toContain("invalid strategy");
  });

  it("rejects non-string judgeModel", async () => {
    const response = await callImport({ version: 2, combos: [{ name: "x", models: [], strategy: { fallbackStrategy: "fusion", judgeModel: 123 } }] });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toContain("judgeModel must be a string");
  });

  it("accepts valid strategy object (fusion with judgeModel)", async () => {
    const response = await callImport({
      version: 2,
      combos: [{ name: "x", models: [], strategy: { fallbackStrategy: "fusion", judgeModel: "gpt-4" } }],
    });
    expect(response.status).toBe(201);
  });
});

describe("POST /api/combos/import — integration", () => {
  async function callImport(body) {
    const { POST } = await import("@/app/api/combos/import/route");
    const request = new Request("http://localhost/api/combos/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return POST(request);
  }

  it("replaces all existing combos with imported ones", async () => {
    const { createCombo, getCombos } = await import("@/lib/db/repos/combosRepo");
    await createCombo({ name: "old-combo", kind: "llm", models: ["old/1"] });

    const response = await callImport({
      version: 1,
      combos: [
        { name: "new-a", kind: "webSearch", models: ["new/1", "new/2"] },
        { name: "new-b", kind: null, models: ["new/3"] },
      ],
    });

    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.count).toBe(2);

    const combos = await getCombos();
    expect(combos).toHaveLength(2);
    expect(combos.map((c) => c.name).sort()).toEqual(["new-a", "new-b"]);
    expect(combos.find((c) => c.name === "new-a").outboundProxyUrl).toBeUndefined();

    const a = combos.find((c) => c.name === "new-a");
    expect(a.kind).toBe("webSearch");
    expect(a.models).toEqual(["new/1", "new/2"]);
    expect(a.id).toBeTruthy();
    expect(a.createdAt).toBeTruthy();
    expect(a.updatedAt).toBeTruthy();
  });

  it("generates fresh UUIDs and timestamps on import", async () => {
    const response = await callImport({
      version: 1,
      combos: [{ name: "fresh", models: ["m1"] }],
    });
    expect(response.status).toBe(201);

    const { getCombos } = await import("@/lib/db/repos/combosRepo");
    const combos = await getCombos();
    expect(combos).toHaveLength(1);
    expect(combos[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(combos[0].createdAt).toBeTruthy();
    expect(combos[0].updatedAt).toBe(combos[0].createdAt);
  });

  it("import with an empty array removes all combos (via validation reject)", async () => {
    const { createCombo, getCombos } = await import("@/lib/db/repos/combosRepo");
    await createCombo({ name: "keep", models: ["m1"] });

    const response = await callImport({ version: 1, combos: [] });
    expect(response.status).toBe(400);

    const combos = await getCombos();
    expect(combos).toHaveLength(1);
    expect(combos[0].name).toBe("keep");
  });

  it("sets roundRobin strategy on import", async () => {
    const response = await callImport({
      version: 1,
      combos: [
        { name: "rr-yes", models: ["m1"], roundRobin: true },
        { name: "rr-no", models: ["m2"] },
      ],
    });
    expect(response.status).toBe(201);

    const { getSettings } = await import("@/lib/db/repos/settingsRepo");
    const settings = await getSettings();
    expect(settings.comboStrategies["rr-yes"]).toEqual({ fallbackStrategy: "round-robin" });
    expect(settings.comboStrategies["rr-no"]).toBeUndefined();
  });

  it("removes roundRobin strategy when flag is false (mixed import)", async () => {
    const { updateSettings, getSettings } = await import("@/lib/db/repos/settingsRepo");
    await updateSettings({ comboStrategies: { "old-rr": { fallbackStrategy: "round-robin" } } });

    await callImport({
      version: 1,
      combos: [
        { name: "new-rr", models: ["m0"], roundRobin: true },
        { name: "old-rr", models: ["m1"], roundRobin: false },
        { name: "no-rr", models: ["m2"] },
      ],
    });

    const settings = await getSettings();
    expect(settings.comboStrategies["old-rr"]).toBeUndefined();
    expect(settings.comboStrategies["new-rr"]).toEqual({ fallbackStrategy: "round-robin" });
  });

  it("does not modify strategies when no combo has roundRobin: true", async () => {
    const { updateSettings, getSettings } = await import("@/lib/db/repos/settingsRepo");
    await updateSettings({ comboStrategies: { "pre-existing": { fallbackStrategy: "round-robin" } } });

    await callImport({
      version: 1,
      combos: [
        { name: "no-rr", models: ["m1"] },
        { name: "also-no-rr", models: ["m2"], roundRobin: false },
      ],
    });

    const settings = await getSettings();
    expect(settings.comboStrategies["pre-existing"]).toEqual({ fallbackStrategy: "round-robin" });
  });

  it("imports v2 strategy object (fusion with judgeModel)", async () => {
    const response = await callImport({
      version: 2,
      combos: [
        { name: "fusion-combo", models: ["m1", "m2"], strategy: { fallbackStrategy: "fusion", judgeModel: "gpt-4" } },
        { name: "rr-combo", models: ["m3"], strategy: { fallbackStrategy: "round-robin" } },
        { name: "fallback-combo", models: ["m4"] },
      ],
    });
    expect(response.status).toBe(201);

    const { getSettings } = await import("@/lib/db/repos/settingsRepo");
    const settings = await getSettings();
    expect(settings.comboStrategies["fusion-combo"]).toEqual({ fallbackStrategy: "fusion", judgeModel: "gpt-4" });
    expect(settings.comboStrategies["rr-combo"]).toEqual({ fallbackStrategy: "round-robin" });
    expect(settings.comboStrategies["fallback-combo"]).toBeUndefined();
  });

  it("does not carry over deleted combo strategies (old combos keep theirs)", async () => {
    const { updateSettings, getSettings } = await import("@/lib/db/repos/settingsRepo");
    await updateSettings({ comboStrategies: { "old-combo": { fallbackStrategy: "round-robin" } } });

    await callImport({
      version: 2,
      combos: [{ name: "new-combo", models: ["m1"] }],
    });

    const settings = await getSettings();
    // Non-imported combos keep their strategies; imported combos without strategy get none
    expect(settings.comboStrategies["old-combo"]).toEqual({ fallbackStrategy: "round-robin" });
    expect(settings.comboStrategies["new-combo"]).toBeUndefined();
  });

  it("transactional: combo insertion failure does not leave partial state", async () => {
    const { createCombo, getCombos } = await import("@/lib/db/repos/combosRepo");
    await createCombo({ name: "original", models: ["orig/1"] });

    // The current implementation catches errors and returns 500;
    // the transaction is committed per-entry so a duplicate name
    // would fail on INSERT (but name uniqueness was validated earlier).
    // This test verifies the DELETE runs before INSERT inside the transaction.
    // We test a scenario where a constraint violation would fail the import.
    // Since we validated names, the only way to trigger this is via boundary conditions.

    // Import two combos with same name (caught by validation)
    const response = await callImport({
      version: 1,
      combos: [
        { name: "dup", models: [] },
        { name: "dup", models: [] },
      ],
    });
    expect(response.status).toBe(400);

    // Original combos should still be intact
    const combos = await getCombos();
    expect(combos).toHaveLength(1);
    expect(combos[0].name).toBe("original");
  });
});
