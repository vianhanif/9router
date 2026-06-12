import { NextResponse } from "next/server";
import { getUsageStats, getMonthlyUsage } from "@/lib/usageDb";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all", "monthly"]);

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    if (period === "monthly") {
      const month = searchParams.get("month");
      if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        return NextResponse.json({ error: "Invalid month format. Use YYYY-MM." }, { status: 400 });
      }
      // Enforce 24-month range limit
      const [yr, mo] = month.split("-").map(Number);
      const monthsAgo = (new Date().getFullYear() - yr) * 12 + (new Date().getMonth() + 1 - mo);
      if (monthsAgo < 0 || monthsAgo > 24) {
        return NextResponse.json({ error: "Month out of range. Max 24 months history." }, { status: 400 });
      }
      const stats = await getMonthlyUsage(month);
      return NextResponse.json(stats);
    }

    const stats = await getUsageStats(period);
    return NextResponse.json(stats);
  } catch (error) {
    console.error("[API] Failed to get usage stats:", error);
    return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500 });
  }
}
