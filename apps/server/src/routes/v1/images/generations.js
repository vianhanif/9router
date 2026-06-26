import { Hono } from "hono";
import { handleImageGeneration } from "../../../handlers/imageGeneration.js";

const router = new Hono();

router.post("/images/generations", async (c) => {
  const response = await handleImageGeneration(c.req.raw);
  return response;
});

export { router as imageGenerationsRouter };
