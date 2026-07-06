import { Hono } from "hono";
import { getSettings, getProviderConnections, getCombos, getProviderNodes } from "@9router/db";
import { getHeadroomStatus } from "../services/headroom.js";

const statusRouter = new Hono();

/**
 * GET /api/status/summary
 * Aggregated dashboard data: token savers, active providers, combos, headroom
 */
statusRouter.get("/summary", async (c) => {
  try {
    const [settings, connections, combos, nodes, headroomRes] = await Promise.all([
      getSettings().catch(() => ({})),
      getProviderConnections({ isActive: true }).catch(() => []),
      getCombos().catch(() => []),
      getProviderNodes().catch(() => []),
      getHeadroomStatus().catch(() => ({ status: "unknown" })),
    ]);

    // Token saver tools
    const tokenSavers = {
      headroom: {
        enabled: !!settings.headroomEnabled,
        url: settings.headroomUrl || null,
        compressUserMessages: !!settings.headroomCompressUserMessages,
        status: headroomRes.status || "unknown",
        managedPid: headroomRes.managedPid || null,
      },
      caveman: {
        enabled: !!settings.cavemanEnabled,
        level: settings.cavemanLevel || "full",
      },
      ponytail: {
        enabled: !!settings.ponytailEnabled,
        level: settings.ponytailLevel || "full",
      },
      rtk: {
        enabled: settings.rtkEnabled !== false,
      },
    };

    // Active providers (deduped by provider id)
    const seen = new Set();
    const providerList = [];
    for (const conn of connections) {
      const pid = conn.provider;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const otherConns = connections.filter((c) => c.provider === pid);
      const accountNames = otherConns
        .map((c) => c.displayName || c.name || c.email || null)
        .filter(Boolean);
      providerList.push({
        id: pid,
        displayName: otherConns[0]?.displayName || pid,
        accounts: otherConns.length,
        accountNames: [...new Set(accountNames)],
        authTypes: [...new Set(otherConns.map((c) => c.authType))],
      });
    }

    // Custom nodes
    const customNodes = nodes
      .filter((n) => n.prefix)
      .map((n) => ({
        id: n.id,
        prefix: n.prefix,
        type: n.type,
        name: n.name,
      }));

    // Combos with model detail
    const comboList = combos.map((combo) => ({
      id: combo.id,
      name: combo.name,
      kind: combo.kind || "llm",
      modelCount: (combo.models || []).length,
      models: (combo.models || []),
    }));

    return c.json({
      tokenSavers,
      providers: providerList,
      customNodes,
      combos: comboList,
      settings: {
        comboStrategy: settings.comboStrategy || "fallback",
        comboStickyRoundRobinLimit: settings.comboStickyRoundRobinLimit ?? 1,
        fallbackStrategy: settings.fallbackStrategy || "fill-first",
      },
    });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

export default statusRouter;
