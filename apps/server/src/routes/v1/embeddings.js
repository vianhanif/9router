import { Hono } from "hono";
import { handleEmbeddings } from "../../handlers/embeddings.js";

const router = new Hono();

router.post("/embeddings", async (c) => {
  const response = await handleEmbeddings(c.req.raw);
  return response;
});

export { router as embeddingsRouter };
