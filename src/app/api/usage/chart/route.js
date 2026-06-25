import { getChartData } from "@/lib/db/repos/usageRepo";
import { NextResponse } from "next/server";

async function handleStandardChart(period) {
  const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d"]);
  if (!VALID_PERIODS.has(period)) return null;
  return NextResponse.json(await getChartData(period));
}

async function handleMonthlyChart(searchParams) {
  const month = searchParams.get("month");
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: "Invalid month format (expected YYYY-MM)" }, { status: 400 });
  }
  const cutoffDay = Math.min(Math.max(parseInt(searchParams.get("cutoffDay")) || 1, 1), 28);
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
