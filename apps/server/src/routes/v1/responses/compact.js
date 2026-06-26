import { Hono } from "hono";
import { handleChat } from "../../../handlers/chat.js";
import { ensureInitialized } from "../../init.js";

const router = new Hono();

router.post("/responses/compact", async (c) => {
  await ensureInitialized();
  const body = await c.req.json();
  body._compact = true;
  const newRequest = new Request(c.req.url, {
    method: "POST",
    headers: c.req.raw.headers,
    body: JSON.stringify(body),
  });
  const response = await handleChat(newRequest);
  return response;
});

export { router as responsesCompactRouter };
