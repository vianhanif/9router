import { Hono } from "hono";
import { handleChat } from "../../../handlers/chat.js";
import { ensureInitialized } from "../../init.js";
import { transformToOllama } from "@9router/core/utils/ollamaTransform.js";

const router = new Hono();

router.post("/api/chat", async (c) => {
  await ensureInitialized();

  // Ollama-compatible /api/chat endpoint
  const clonedReq = c.req.raw.clone();
  let modelName = "llama3.2";
  try {
    const body = await clonedReq.json();
    modelName = body.model || "llama3.2";
  } catch {}

  const response = await handleChat(c.req.raw);
  return transformToOllama(response, modelName);
});

export { router as apiChatRouter };
