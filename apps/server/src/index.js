import { serve } from "@hono/node-server";
import { initDb } from "@9router/db";
import { createApp } from "./app.js";
import { PORT, HOST } from "./config.js";

async function main() {
  await initDb();
  const app = createApp();

  serve({
    fetch: app.fetch,
    port: PORT,
    hostname: HOST,
  }, (info) => {
    console.log(`9router-server listening on ${info.address}:${info.port}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
