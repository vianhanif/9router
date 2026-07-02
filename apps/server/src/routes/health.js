import { Hono } from "hono";
import { initDb } from "@9router/db";

const router = new Hono();

router.get("/", async (c) => {
  try {
    await initDb();
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  } catch (err) {
    return c.json({ status: "error", message: err.message }, 500);
  }
});

export { router as healthRouter };
