import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "@/lib/db/driver";
import { stringifyJson } from "@/lib/db/helpers/jsonCol";
import { getSettings, updateSettings } from "@/lib/localDb";

export const dynamic = "force-dynamic";

const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;
const VALID_KINDS = ["llm", "webSearch", "webFetch"];

export async function POST(request) {
  try {
    const body = await request.json();

    // Validate top-level structure
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON: expected an object with version and combos" }, { status: 400 });
    }

    if (!body.version || typeof body.version !== "number") {
      return NextResponse.json({ error: "Missing or invalid version field" }, { status: 400 });
    }

    if (!Array.isArray(body.combos)) {
      return NextResponse.json({ error: "Combos must be an array" }, { status: 400 });
    }

    if (body.combos.length === 0) {
      return NextResponse.json({ error: "At least one combo is required" }, { status: 400 });
    }

    // Validate each combo
    const nameSet = new Set();
    for (let i = 0; i < body.combos.length; i++) {
      const combo = body.combos[i];
      const idx = i + 1;

      if (!combo || typeof combo !== "object" || Array.isArray(combo)) {
        return NextResponse.json({ error: `Combo ${idx}: invalid entry` }, { status: 400 });
      }

      if (!combo.name || typeof combo.name !== "string" || !combo.name.trim()) {
        return NextResponse.json({ error: `Combo ${idx}: name is required` }, { status: 400 });
      }

      if (!VALID_NAME_REGEX.test(combo.name)) {
        return NextResponse.json({ error: `Combo ${idx}: name "${combo.name}" can only contain letters, numbers, -, _ and .` }, { status: 400 });
      }

      if (nameSet.has(combo.name)) {
        return NextResponse.json({ error: `Combo ${idx}: duplicate name "${combo.name}"` }, { status: 400 });
      }
      nameSet.add(combo.name);

      if (combo.kind != null && !VALID_KINDS.includes(combo.kind)) {
        return NextResponse.json({ error: `Combo ${idx}: invalid kind "${combo.kind}"` }, { status: 400 });
      }

      if (!Array.isArray(combo.models)) {
        return NextResponse.json({ error: `Combo ${idx}: models must be an array` }, { status: 400 });
      }

      if (combo.roundRobin != null && typeof combo.roundRobin !== "boolean") {
        return NextResponse.json({ error: `Combo ${idx}: roundRobin must be a boolean` }, { status: 400 });
      }
    }

    // Execute import in a single transaction
    const db = await getAdapter();
    const now = new Date().toISOString();

    db.transaction(() => {
      // Delete all existing combos
      db.run(`DELETE FROM combos`);

      // Insert each combo with new UUID and current timestamp
      for (const combo of body.combos) {
        db.run(
          `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
          [
            uuidv4(),
            combo.name.trim(),
            combo.kind || null,
            stringifyJson(combo.models || []),
            now,
            now,
          ]
        );
      }
    });

    // Update comboStrategies in settings if roundRobin is present
    const hasRoundRobin = body.combos.some((combo) => combo.roundRobin === true);
    if (hasRoundRobin) {
      const settings = await getSettings();
      const currentStrategies = settings?.comboStrategies || {};
      const updatedStrategies = { ...currentStrategies };

      for (const combo of body.combos) {
        if (combo.roundRobin === true) {
          updatedStrategies[combo.name.trim()] = { fallbackStrategy: "round-robin" };
        } else {
          delete updatedStrategies[combo.name.trim()];
        }
      }

      await updateSettings({ comboStrategies: updatedStrategies });
    }

    return NextResponse.json({ success: true, count: body.combos.length }, { status: 201 });
  } catch (error) {
    console.log("Error importing combos:", error);
    return NextResponse.json({ error: "Failed to import combos" }, { status: 500 });
  }
}
