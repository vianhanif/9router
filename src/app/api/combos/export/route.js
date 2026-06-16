import { NextResponse } from "next/server";
import { getCombos, getSettings } from "@/lib/localDb";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [combos, settings] = await Promise.all([
      getCombos(),
      getSettings(),
    ]);

    const comboStrategies = settings?.comboStrategies || {};

    const exportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      combos: combos.map((combo) => ({
        name: combo.name,
        kind: combo.kind,
        models: combo.models,
        roundRobin: comboStrategies[combo.name]?.fallbackStrategy === "round-robin" || false,
      })),
    };

    const jsonStr = JSON.stringify(exportData, null, 2);

    return new NextResponse(jsonStr, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="combos-export.json"`,
      },
    });
  } catch (error) {
    console.log("Error exporting combos:", error);
    return NextResponse.json({ error: "Failed to export combos" }, { status: 500 });
  }
}
