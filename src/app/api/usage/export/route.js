import { NextResponse } from "next/server";
import { getMonthlyUsage } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period");
    const month = searchParams.get("month");
    const format = searchParams.get("format") || "json";

    if (period !== "monthly" || !month || !/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json({ error: "Specify period=monthly&month=YYYY-MM" }, { status: 400 });
    }

    if (!["json", "csv"].includes(format)) {
      return NextResponse.json({ error: "Format must be 'json' or 'csv'" }, { status: 400 });
    }

    const data = await getMonthlyUsage(month);

    if (format === "csv") {
      // RFC 4180 CSV quoting helper
      const csvEscape = (val) => {
        const str = String(val);
        if (str.includes(",") || str.includes('"') || str.includes("\n")) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

      // Build CSV rows from byProvider
      const headers = ["Provider", "Requests", "Request %", "Input Tokens", "Output Tokens", "Total Tokens", "Token %"];
      const rows = Object.entries(data.byProvider).map(([provider, stats]) => [
        provider,
        stats.requests,
        stats.requestPercentage.toFixed(2),
        stats.promptTokens,
        stats.completionTokens,
        stats.totalTokens,
        stats.tokenPercentage.toFixed(2),
      ]);

      // Add totals row
      rows.push([
        "TOTAL",
        data.totals.requests,
        "100.00",
        data.totals.promptTokens,
        data.totals.completionTokens,
        data.totals.totalTokens,
        "100.00",
      ]);

      const csvContent = [
        headers.map(csvEscape).join(","),
        ...rows.map((r) => r.map(csvEscape).join(",")),
      ].join("\n");

      return new NextResponse(csvContent, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="usage-report-${month}.csv"`,
        },
      });
    }

    // JSON format
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Export failed:", error);
    return NextResponse.json({ error: "Export failed" }, { status: 500 });
  }
}
