import { Hono } from "hono";
import { buildModelsList } from "../models.js";

const router = new Hono();

// URL slug → service kind(s). `web` covers both webSearch and webFetch.
const KIND_SLUG_MAP = {
  "image": ["image"],
  "tts": ["tts"],
  "stt": ["stt"],
  "embedding": ["embedding"],
  "image-to-text": ["imageToText"],
  "web": ["webSearch", "webFetch"],
};

/**
 * GET /v1/models/:kind — OpenAI-compatible models list filtered by capability.
 * Supported kinds: image, tts, stt, embedding, image-to-text, web.
 */
router.get("/models/:kind", async (c) => {
  try {
    const kind = c.req.param("kind");
    const kindFilter = KIND_SLUG_MAP[kind];

    if (!kindFilter) {
      return c.json(
        {
          error: {
            message: `Unknown model kind: ${kind}. Supported: ${Object.keys(KIND_SLUG_MAP).join(", ")}`,
            type: "invalid_request_error",
          },
        },
        404
      );
    }

    const data = await buildModelsList(kindFilter);
    return c.json({ object: "list", data });
  } catch (error) {
    console.log("Error fetching models by kind:", error);
    return c.json(
      { error: { message: error.message, type: "server_error" } },
      500
    );
  }
});

export { router as modelsKindRouter };
