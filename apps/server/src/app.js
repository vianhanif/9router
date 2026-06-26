import { Hono } from "hono";
import { cors } from "hono/cors";
import { authMiddleware } from "./middleware/auth.js";
import { v1Router } from "./routes/v1/index.js";
import { healthRouter } from "./routes/health.js";

export function createApp() {
  const app = new Hono();

  app.use("*", cors());
  app.use("/v1/*", authMiddleware);
  app.route("/v1", v1Router);
  app.route("/health", healthRouter);

  return app;
}
