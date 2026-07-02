import { Hono } from "hono";
import { handleTts } from "../../../handlers/tts.js";

const router = new Hono();

router.post("/audio/speech", async (c) => {
  const response = await handleTts(c.req.raw);
  return response;
});

export { router as ttsRouter };
