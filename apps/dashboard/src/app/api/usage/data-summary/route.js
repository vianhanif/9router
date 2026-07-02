import { NextResponse } from "next/server";
import { getDataSummary } from "@9router/db/repos/usageRepo.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const summary = await getDataSummary();
    return NextResponse.json(summary);
  } catch (error) {
    console.error("[API] Failed to get data summary:", error);
    return NextResponse.json({ error: "Failed to fetch data summary" }, { status: 500 });
  }
}
