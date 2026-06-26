import { Hono } from "hono";
import { handleChat } from "../../../handlers/chat.js";
import { ensureInitialized } from "../../init.js";

const router = new Hono();

router.post("/chat/completions", async (c) => {
  await ensureInitialized();
  const response = await handleChat(c.req.raw);
  return response;
});

export { router as chatCompletionsRouter };
