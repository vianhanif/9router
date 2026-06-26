import { Hono } from "hono";
import { handleFetch } from "../../../handlers/fetch.js";

const router = new Hono();

router.post("/web/fetch", async (c) => {
  const response = await handleFetch(c.req.raw);
  return response;
});

export { router as fetchRouter };
