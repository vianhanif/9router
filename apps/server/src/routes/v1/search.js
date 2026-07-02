import { Hono } from "hono";
import { handleSearch } from "../../handlers/search.js";

const router = new Hono();

router.post("/search", async (c) => {
  const response = await handleSearch(c.req.raw);
  return response;
});

export { router as searchRouter };
