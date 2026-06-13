import { NextResponse } from "next/server";
import { getDeletePreview, getOldestRecordDate, deleteUsageData } from "@/lib/db/repos/usageRepo.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action");
    const months = parseInt(searchParams.get("months"), 10);

    if (action !== "dry-run") {
      return NextResponse.json({ error: "Invalid action. Use 'dry-run'." }, { status: 400 });
    }

    const oldestDate = await getOldestRecordDate();
    if (!oldestDate) {
      return NextResponse.json({ totalMonths: 0, oldestDate: null, preview: null });
    }

    const oldest = new Date(oldestDate);
    const now = new Date();
    const totalMonths = (now.getFullYear() - oldest.getFullYear()) * 12 + (now.getMonth() - oldest.getMonth());

    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const cutoffDate = cutoff.toISOString();
    const cutoffDateKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;

    const preview = await getDeletePreview(cutoffDate);

    return NextResponse.json({
      totalMonths,
      oldestDate,
      preview,
      cutoffDate,
    });
  } catch (error) {
    console.error("[API] clear preview failed:", error);
    return NextResponse.json({ error: "Failed to get clear preview" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const months = parseInt(body.months, 10);

    if (![1, 3, 6, 12].includes(months)) {
      return NextResponse.json({ error: "Invalid retention period. Must be 1, 3, 6, or 12 months." }, { status: 400 });
    }

    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const cutoffDate = cutoff.toISOString();
    const cutoffDateKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;

    const deletedRows = await deleteUsageData(cutoffDate, cutoffDateKey);

    return NextResponse.json({ success: true, deletedRows, cutoffDate });
  } catch (error) {
    console.error("[API] clear failed:", error);
    return NextResponse.json({ error: "Failed to clear usage data" }, { status: 500 });
  }
}
