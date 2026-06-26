import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db/repos/usageRepo", () => ({ getChartData: vi.fn() }));

describe("GET /api/usage/chart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockChartData = [
    { label: "Jun 25", tokens: 15000, cost: 0.15, dateKey: "2026-06-25" },
    { label: "Jun 26", tokens: 22000, cost: 0.22, dateKey: "2026-06-26" },
  ];

  it("should return chart data for standard period 'today'", async () => {
    const { getChartData } = await import("@/lib/db/repos/usageRepo");
    const { GET } = await import("../../src/app/api/usage/chart/route.js");
    getChartData.mockResolvedValue(mockChartData);

    const req = new Request("http://localhost/api/usage/chart?period=today");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(mockChartData);
    expect(getChartData).toHaveBeenCalledWith("today");
  });

  it("should return chart data for standard period '24h'", async () => {
    const { getChartData } = await import("@/lib/db/repos/usageRepo");
    const { GET } = await import("../../src/app/api/usage/chart/route.js");
    getChartData.mockResolvedValue(mockChartData);

    const req = new Request("http://localhost/api/usage/chart?period=24h");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(getChartData).toHaveBeenCalledWith("24h");
  });

  it("should return chart data for standard period '7d'", async () => {
    const { getChartData } = await import("@/lib/db/repos/usageRepo");
    const { GET } = await import("../../src/app/api/usage/chart/route.js");
    getChartData.mockResolvedValue(mockChartData);

    const req = new Request("http://localhost/api/usage/chart?period=7d");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(getChartData).toHaveBeenCalledWith("7d");
  });

  it("should return chart data for standard period '30d'", async () => {
    const { getChartData } = await import("@/lib/db/repos/usageRepo");
    const { GET } = await import("../../src/app/api/usage/chart/route.js");
    getChartData.mockResolvedValue(mockChartData);

    const req = new Request("http://localhost/api/usage/chart?period=30d");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(getChartData).toHaveBeenCalledWith("30d");
  });

  it("should return chart data for standard period '60d'", async () => {
    const { getChartData } = await import("@/lib/db/repos/usageRepo");
    const { GET } = await import("../../src/app/api/usage/chart/route.js");
    getChartData.mockResolvedValue(mockChartData);

    const req = new Request("http://localhost/api/usage/chart?period=60d");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(getChartData).toHaveBeenCalledWith("60d");
  });

  it("should return chart data for monthly period with cutoffDay", async () => {
    const { getChartData } = await import("@/lib/db/repos/usageRepo");
    const { GET } = await import("../../src/app/api/usage/chart/route.js");
    getChartData.mockResolvedValue(mockChartData);

    const req = new Request("http://localhost/api/usage/chart?period=monthly&month=2025-06&cutoffDay=15");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(mockChartData);
    expect(getChartData).toHaveBeenCalledWith("monthly", { yearMonth: "2025-06", cutoffDay: 15 });
  });

  it("should return chart data for hourly granularity", async () => {
    const { getChartData } = await import("@/lib/db/repos/usageRepo");
    const { GET } = await import("../../src/app/api/usage/chart/route.js");
    getChartData.mockResolvedValue(mockChartData);

    const req = new Request("http://localhost/api/usage/chart?granularity=hour&dateKey=2026-06-26");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(mockChartData);
    expect(getChartData).toHaveBeenCalledWith("hourly", { dateKey: "2026-06-26" });
  });

  it("should return chart data for minute granularity", async () => {
    const { getChartData } = await import("@/lib/db/repos/usageRepo");
    const { GET } = await import("../../src/app/api/usage/chart/route.js");
    getChartData.mockResolvedValue(mockChartData);

    const req = new Request("http://localhost/api/usage/chart?granularity=minute&dateKey=2026-06-26&hour=14");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(mockChartData);
    expect(getChartData).toHaveBeenCalledWith("minute", { dateKey: "2026-06-26", hour: 14 });
  });

  it("should return 400 for invalid month format", async () => {
    const { GET } = await import("../../src/app/api/usage/chart/route.js");

    const req = new Request("http://localhost/api/usage/chart?period=monthly&month=2025-6");
    const res = await GET(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid month format");
  });

  it("should return 400 for month exceeding 24-month range", async () => {
    const { GET } = await import("../../src/app/api/usage/chart/route.js");

    const req = new Request("http://localhost/api/usage/chart?period=monthly&month=2020-01");
    const res = await GET(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Month exceeds 24-month range");
  });

  it("should return 400 for invalid dateKey on hourly granularity", async () => {
    const { GET } = await import("../../src/app/api/usage/chart/route.js");

    const req = new Request("http://localhost/api/usage/chart?granularity=hour&dateKey=2026/06/26");
    const res = await GET(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid dateKey");
  });

  it("should return 400 for invalid dateKey on minute granularity", async () => {
    const { GET } = await import("../../src/app/api/usage/chart/route.js");

    const req = new Request("http://localhost/api/usage/chart?granularity=minute&dateKey=not-a-date&hour=10");
    const res = await GET(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid dateKey");
  });

  it("should return 400 for invalid hour", async () => {
    const { GET } = await import("../../src/app/api/usage/chart/route.js");

    const req = new Request("http://localhost/api/usage/chart?granularity=minute&dateKey=2026-06-26&hour=99");
    const res = await GET(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid hour");
  });

  it("should return 400 for invalid period", async () => {
    const { GET } = await import("../../src/app/api/usage/chart/route.js");

    const req = new Request("http://localhost/api/usage/chart?period=invalid");
    const res = await GET(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid period");
  });

  it("should return 500 when getChartData throws", async () => {
    const { getChartData } = await import("@/lib/db/repos/usageRepo");
    const { GET } = await import("../../src/app/api/usage/chart/route.js");
    getChartData.mockRejectedValue(new Error("DB connection failed"));

    const req = new Request("http://localhost/api/usage/chart?period=7d");
    const res = await GET(req);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain("Failed to fetch chart data");
  });
});
