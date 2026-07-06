import { Hono } from "hono";
import { stats } from "../services/stats.js";

const statsRouter = new Hono();

statsRouter.get("/info", (c) => {
  return c.json(stats.getStats());
});

statsRouter.get("/log", (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
  return c.json(stats.getRecentLog(limit));
});

export default statsRouter;
