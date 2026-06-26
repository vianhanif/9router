import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db/repos/usageRepo.js", () => ({
  getDataSummary: vi.fn(),
  getOldestRecordDate: vi.fn(),
  getDeletePreview: vi.fn(),
  deleteUsageData: vi.fn(),
}));

describe("GET /api/usage/data-summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockSummary = {
    totalRecords: 1000,
    totalTokens: 500000,
    totalCost: 12.5,
    oldestRecord: "2025-01-01",
    newestRecord: "2026-06-26",
  };

  it("should return summary data", async () => {
    const { getDataSummary } = await import("@/lib/db/repos/usageRepo.js");
    const { GET } = await import("../../src/app/api/usage/data-summary/route.js");
    getDataSummary.mockResolvedValue(mockSummary);

    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(mockSummary);
    expect(getDataSummary).toHaveBeenCalledOnce();
  });

  it("should return 500 when getDataSummary throws", async () => {
    const { getDataSummary } = await import("@/lib/db/repos/usageRepo.js");
    const { GET } = await import("../../src/app/api/usage/data-summary/route.js");
    getDataSummary.mockRejectedValue(new Error("DB failure"));

    const res = await GET();
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain("Failed to fetch data summary");
  });
});

describe("GET /api/usage/clear (dry-run)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return preview for dry-run with valid months", async () => {
    const { getOldestRecordDate, getDeletePreview } = await import("@/lib/db/repos/usageRepo.js");
    const { GET } = await import("../../src/app/api/usage/clear/route.js");
    getOldestRecordDate.mockResolvedValue("2020-01-15");
    getDeletePreview.mockResolvedValue({ totalRows: 100 });

    const req = new Request("http://localhost/api/usage/clear?action=dry-run&months=6");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.oldestDate).toBe("2020-01-15");
    expect(data.preview).toEqual({ totalRows: 100 });
    expect(data.totalMonths).toBeGreaterThan(0);
    expect(data.cutoffDate).toEqual(expect.any(String));
    expect(getOldestRecordDate).toHaveBeenCalledOnce();
    expect(getDeletePreview).toHaveBeenCalledOnce();
  });

  it("should return 400 for invalid action", async () => {
    const { GET } = await import("../../src/app/api/usage/clear/route.js");

    const req = new Request("http://localhost/api/usage/clear?action=delete&months=6");
    const res = await GET(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid action");
  });

  it("should return zero preview when no oldest date exists", async () => {
    const { getOldestRecordDate } = await import("@/lib/db/repos/usageRepo.js");
    const { GET } = await import("../../src/app/api/usage/clear/route.js");
    getOldestRecordDate.mockResolvedValue(null);

    const req = new Request("http://localhost/api/usage/clear?action=dry-run&months=6");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      totalMonths: 0,
      oldestDate: null,
      preview: null,
    });
  });

  it("should return 500 when getOldestRecordDate throws", async () => {
    const { getOldestRecordDate } = await import("@/lib/db/repos/usageRepo.js");
    const { GET } = await import("../../src/app/api/usage/clear/route.js");
    getOldestRecordDate.mockRejectedValue(new Error("DB error"));

    const req = new Request("http://localhost/api/usage/clear?action=dry-run&months=6");
    const res = await GET(req);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain("Failed to get clear preview");
  });
});

describe("POST /api/usage/clear", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should delete data for 1 month retention and return success", async () => {
    const { deleteUsageData } = await import("@/lib/db/repos/usageRepo.js");
    const { POST } = await import("../../src/app/api/usage/clear/route.js");
    deleteUsageData.mockResolvedValue(50);

    const req = new Request("http://localhost/api/usage/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ months: 1 }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.deletedRows).toBe(50);
    expect(data.cutoffDate).toEqual(expect.any(String));
    expect(deleteUsageData).toHaveBeenCalledOnce();
  });

  it("should delete data for 3 month retention", async () => {
    const { deleteUsageData } = await import("@/lib/db/repos/usageRepo.js");
    const { POST } = await import("../../src/app/api/usage/clear/route.js");
    deleteUsageData.mockResolvedValue(100);

    const req = new Request("http://localhost/api/usage/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ months: 3 }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.deletedRows).toBe(100);
  });

  it("should delete data for 6 month retention", async () => {
    const { deleteUsageData } = await import("@/lib/db/repos/usageRepo.js");
    const { POST } = await import("../../src/app/api/usage/clear/route.js");
    deleteUsageData.mockResolvedValue(200);

    const req = new Request("http://localhost/api/usage/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ months: 6 }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.deletedRows).toBe(200);
  });

  it("should delete data for 12 month retention", async () => {
    const { deleteUsageData } = await import("@/lib/db/repos/usageRepo.js");
    const { POST } = await import("../../src/app/api/usage/clear/route.js");
    deleteUsageData.mockResolvedValue(500);

    const req = new Request("http://localhost/api/usage/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ months: 12 }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.deletedRows).toBe(500);
  });

  it("should return 400 for invalid months (2)", async () => {
    const { POST } = await import("../../src/app/api/usage/clear/route.js");

    const req = new Request("http://localhost/api/usage/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ months: 2 }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Must be 1, 3, 6, or 12");
  });

  it("should return 400 for invalid months (99)", async () => {
    const { POST } = await import("../../src/app/api/usage/clear/route.js");

    const req = new Request("http://localhost/api/usage/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ months: 99 }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Must be 1, 3, 6, or 12");
  });

  it("should return 500 when deleteUsageData throws", async () => {
    const { deleteUsageData } = await import("@/lib/db/repos/usageRepo.js");
    const { POST } = await import("../../src/app/api/usage/clear/route.js");
    deleteUsageData.mockRejectedValue(new Error("DB error"));

    const req = new Request("http://localhost/api/usage/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ months: 6 }),
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain("Failed to clear usage data");
  });
});
