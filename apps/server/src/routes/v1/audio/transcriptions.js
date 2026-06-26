import { Hono } from "hono";
import { handleStt } from "../../../handlers/stt.js";

const router = new Hono();

router.post("/audio/transcriptions", async (c) => {
  const response = await handleStt(c.req.raw);
  return response;
});

export { router as sttRouter };
