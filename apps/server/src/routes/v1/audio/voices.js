import { Hono } from "hono";

const router = new Hono();

// Provider → internal voices API. Edge/local-device share the generic endpoint.
const PROVIDER_API = {
  elevenlabs: (origin) => `${origin}/api/media-providers/tts/elevenlabs/voices`,
  deepgram: (origin) => `${origin}/api/media-providers/tts/deepgram/voices`,
  inworld: (origin) => `${origin}/api/media-providers/tts/inworld/voices`,
  "edge-tts": (origin) => `${origin}/api/media-providers/tts/voices?provider=edge-tts`,
  "local-device": (origin) => `${origin}/api/media-providers/tts/voices?provider=local-device`,
};

/**
 * GET /v1/audio/voices?provider={p}[&lang=xx]
 * Returns OpenAI-style list with each voice's full model id ready for /v1/audio/speech
 */
router.get("/audio/voices", async (c) => {
  try {
    const provider = c.req.query("provider");
    const lang = c.req.query("lang");
    const origin = new URL(c.req.url).origin;

    if (!provider || !PROVIDER_API[provider]) {
      return c.json(
        { error: { message: `provider must be one of: ${Object.keys(PROVIDER_API).join(", ")}`, type: "invalid_request_error" } },
        400
      );
    }

    const baseUrl = PROVIDER_API[provider](origin);
    const url = lang ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}lang=${encodeURIComponent(lang)}` : baseUrl;
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok || data.error) {
      return c.json(
        { error: { message: data.error || `Upstream ${res.status}`, type: "server_error" } },
        res.status
      );
    }

    // Import AI_PROVIDERS for alias lookup
    const { AI_PROVIDERS } = await import("@9router/shared/constants/providers");

    // Internal API shape: { voices } when lang filter, else { byLang, languages }
    const rawVoices = lang
      ? (data.voices || [])
      : Object.values(data.byLang || {}).flatMap((l) => l.voices || []);

    const alias = AI_PROVIDERS[provider]?.alias || provider;
    const data_out = rawVoices.map((v) => ({
      id: v.id,
      name: v.name,
      lang: v.lang || "",
      gender: v.gender || "",
      model: `${alias}/${v.id}`,
    }));

    return c.json({ object: "list", data: data_out });
  } catch (err) {
    return c.json(
      { error: { message: err.message || "Failed", type: "server_error" } },
      502
    );
  }
});

export { router as voicesRouter };
