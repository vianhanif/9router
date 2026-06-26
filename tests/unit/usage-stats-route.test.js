import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/usageDb", () => ({
  getUsageStats: vi.fn(),
  getMonthlyUsage: vi.fn(),
}));

describe("GET /api/usage/stats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockStats = {
    totalTokens: 50000,
    totalCost: 0.75,
    requestCount: 120,
  };

  const mockMonthlyStats = {
    month: "2025-06",
    totalTokens: 30000,
    totalCost: 0.45,
    requestCount: 60,
  };

  it("should return stats for standard period '7d'", async () => {
    const { getUsageStats } = await import("@/lib/usageDb");
    const { GET } = await import("../../src/app/api/usage/stats/route.js");
    getUsageStats.mockResolvedValue(mockStats);

    const req = new Request("http://localhost/api/usage/stats?period=7d");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(mockStats);
    expect(getUsageStats).toHaveBeenCalledWith("7d");
  });

  it("should return stats for standard period 'today'", async () => {
    const { getUsageStats } = await import("@/lib/usageDb");
    const { GET } = await import("../../src/app/api/usage/stats/route.js");
    getUsageStats.mockResolvedValue(mockStats);

    const req = new Request("http://localhost/api/usage/stats?period=today");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(getUsageStats).toHaveBeenCalledWith("today");
  });

  it("should return stats for standard period 'all'", async () => {
    const { getUsageStats } = await import("@/lib/usageDb");
    const { GET } = await import("../../src/app/api/usage/stats/route.js");
    getUsageStats.mockResolvedValue(mockStats);

    const req = new Request("http://localhost/api/usage/stats?period=all");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(getUsageStats).toHaveBeenCalledWith("all");
  });

  it("should return monthly stats with cutoffDay", async () => {
    const { getMonthlyUsage } = await import("@/lib/usageDb");
    const { GET } = await import("../../src/app/api/usage/stats/route.js");
    getMonthlyUsage.mockResolvedValue(mockMonthlyStats);

    const req = new Request("http://localhost/api/usage/stats?period=monthly&month=2025-06&cutoffDay=15");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(mockMonthlyStats);
    expect(getMonthlyUsage).toHaveBeenCalledWith("2025-06", 15);
  });

  it("should default cutoffDay to 1 for monthly period", async () => {
    const { getMonthlyUsage } = await import("@/lib/usageDb");
    const { GET } = await import("../../src/app/api/usage/stats/route.js");
    getMonthlyUsage.mockResolvedValue(mockMonthlyStats);

    const req = new Request("http://localhost/api/usage/stats?period=monthly&month=2025-06");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(getMonthlyUsage).toHaveBeenCalledWith("2025-06", 1);
  });

  it("should return 400 for invalid period", async () => {
    const { GET } = await import("../../src/app/api/usage/stats/route.js");

    const req = new Request("http://localhost/api/usage/stats?period=invalid");
    const res = await GET(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid period");
  });

  it("should return 400 for invalid month format", async () => {
    const { GET } = await import("../../src/app/api/usage/stats/route.js");

    const req = new Request("http://localhost/api/usage/stats?period=monthly&month=2025-6");
    const res = await GET(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid month format");
  });

  it("should return 400 for future month (out of range)", async () => {
    const { GET } = await import("../../src/app/api/usage/stats/route.js");

    const req = new Request("http://localhost/api/usage/stats?period=monthly&month=2028-01");
    const res = await GET(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Month out of range");
  });

  it("should return 400 for month exceeding 24-month range", async () => {
    const { GET } = await import("../../src/app/api/usage/stats/route.js");

    const req = new Request("http://localhost/api/usage/stats?period=monthly&month=2020-01");
    const res = await GET(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Month out of range");
  });

  it("should return 500 when getUsageStats throws", async () => {
    const { getUsageStats } = await import("@/lib/usageDb");
    const { GET } = await import("../../src/app/api/usage/stats/route.js");
    getUsageStats.mockRejectedValue(new Error("DB error"));

    const req = new Request("http://localhost/api/usage/stats?period=7d");
    const res = await GET(req);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain("Failed to fetch usage stats");
  });
});
