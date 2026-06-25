import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

function seedDaily(db, dateKey, byProvider) {
  const data = JSON.stringify({ byProvider, byModel: {} });
  db.run(`INSERT OR REPLACE INTO usageDaily(dateKey, data) VALUES(?, ?)`, [dateKey, data]);
}

const PROVIDER_A = "openai";
const PROVIDER_B = "anthropic";

let tempDir;
let usage;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-billing-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  usage = await import("@/lib/db/index.js");
  await usage.initDb();
  const db = await (await import("@/lib/db/driver.js")).getAdapter();

  // --- Jun 24 (before cutoff) ---
  seedDaily(db, "2026-06-24", {
    [PROVIDER_A]: { requests: 5, promptTokens: 1000, completionTokens: 500 },
    [PROVIDER_B]: { requests: 3, promptTokens: 800, completionTokens: 300 },
  });

  // --- Jun 25 (cutoff start) ---
  seedDaily(db, "2026-06-25", {
    [PROVIDER_A]: { requests: 10, promptTokens: 2000, completionTokens: 1000 },
  });

  // --- Jun 26 (inside range) ---
  seedDaily(db, "2026-06-26", {
    [PROVIDER_A]: { requests: 7, promptTokens: 1500, completionTokens: 700 },
    [PROVIDER_B]: { requests: 2, promptTokens: 400, completionTokens: 200 },
  });

  // --- Jul 24 (last day before end) ---
  seedDaily(db, "2026-07-24", {
    [PROVIDER_B]: { requests: 4, promptTokens: 900, completionTokens: 400 },
  });

  // --- Jul 25 (excluded — exclusive end) ---
  seedDaily(db, "2026-07-25", {
    [PROVIDER_A]: { requests: 1, promptTokens: 100, completionTokens: 50 },
  });
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("getMonthlyUsage with cutoffDay", () => {
  it("cutoffDay=25: includes Jun 25–Jul 24, excludes Jun 24 and Jul 25", async () => {
    const result = await usage.getMonthlyUsage("2026-06", 25);

    expect(result.from).toBe("25-06-2026");
    expect(result.to).toBe("24-07-2026");
    expect(result.days).toBe(3); // Jun 25, Jun 26, Jul 24

    // Provider A: Jun 25 (10) + Jun 26 (7) = 17 requests
    expect(result.byProvider[PROVIDER_A].requests).toBe(17);
    expect(result.byProvider[PROVIDER_A].promptTokens).toBe(3500);
    expect(result.byProvider[PROVIDER_A].completionTokens).toBe(1700);

    // Provider B: Jun 26 (2) + Jul 24 (4) = 6 requests
    expect(result.byProvider[PROVIDER_B].requests).toBe(6);
    expect(result.byProvider[PROVIDER_B].promptTokens).toBe(1300);
    expect(result.byProvider[PROVIDER_B].completionTokens).toBe(600);

    // Totals: 17 + 6 = 23 requests
    expect(result.totals.requests).toBe(23);
    expect(result.totals.promptTokens).toBe(4800);
    expect(result.totals.completionTokens).toBe(2300);
    expect(result.totals.totalTokens).toBe(7100);

    // Percentages
    expect(result.byProvider[PROVIDER_A].requestPercentage).toBeCloseTo(73.91, 1);
    expect(result.byProvider[PROVIDER_A].tokenPercentage).toBeCloseTo((5200 / 7100) * 100, 1);
    expect(result.byProvider[PROVIDER_B].requestPercentage).toBeCloseTo(26.09, 1);
    expect(result.byProvider[PROVIDER_B].tokenPercentage).toBeCloseTo((1900 / 7100) * 100, 1);
  });

  it("cutoffDay=1 (default): calendar month boundary", async () => {
    const result = await usage.getMonthlyUsage("2026-06");

    // Default cutoffDay=1: Jun 1 → Jul 1
    // Data: Jun 24, 25, 26
    expect(result.days).toBe(3);
    expect(result.from).toBe("01-06-2026");

    // Provider A = 5 + 10 + 7 = 22
    expect(result.byProvider[PROVIDER_A].requests).toBe(22);
    // Provider B = 3 + 2 = 5
    expect(result.byProvider[PROVIDER_B].requests).toBe(5);
    expect(result.totals.requests).toBe(27);
  });

  it("cutoffDay=31 in 30-day month: clamps to month end", async () => {
    // April has 30 days → cutoffDay=31 clamps to Apr 30
    // Insert a row on Apr 30
    const db = await (await import("@/lib/db/driver.js")).getAdapter();

    // Need fresh import after reset, but we already have `usage` with a DB path
    // Just use the adapter directly
    seedDaily(db, "2026-04-30", {
      [PROVIDER_A]: { requests: 3, promptTokens: 500, completionTokens: 200 },
    });
    seedDaily(db, "2026-04-29", {
      [PROVIDER_B]: { requests: 1, promptTokens: 100, completionTokens: 50 },
    });

    const result = await usage.getMonthlyUsage("2026-04", 31);
    // Apr 30 clamped → start = Apr 30 (since 31 > 30, setDate(0) goes to Apr 30)
    // So start = Apr 30, end = May 30
    // Only Apr 30 data should be included (Apr 29 is before start)
    expect(result.from).toBe("30-04-2026");
    expect(result.byProvider[PROVIDER_A]).toBeDefined();
    expect(result.byProvider[PROVIDER_B]).toBeUndefined();
    expect(result.days).toBe(1);
  });

  it("empty month returns zeroed totals", async () => {
    const result = await usage.getMonthlyUsage("2026-01", 15);

    expect(result.days).toBe(0);
    expect(result.totals.requests).toBe(0);
    expect(result.totals.totalTokens).toBe(0);
    expect(result.byProvider).toEqual({});
    expect(result.byModel).toEqual({});
  });

  it("month field reflects input yearMonth", async () => {
    const result = await usage.getMonthlyUsage("2026-06", 25);
    expect(result.month).toBe("2026-06");
  });
});
