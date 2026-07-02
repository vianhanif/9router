import { getSettings, validateApiKey } from "@9router/db";

/**
 * Hono middleware — API key authentication.
 * Skips /health endpoint.
 */
export async function authMiddleware(c, next) {
  const url = new URL(c.req.url);
  if (url.pathname === "/health") return next();

  const settings = await getSettings();
  if (!settings.requireApiKey) return next();

  const auth = c.req.header("authorization");
  let apiKey = null;
  if (auth?.startsWith("Bearer ")) apiKey = auth.slice(7);
  else if (auth?.startsWith("sk-")) apiKey = auth;

  if (!apiKey) {
    return c.json({ error: { message: "Missing API key" } }, 401);
  }

  const valid = await validateApiKey(apiKey);
  if (!valid) {
    return c.json({ error: { message: "Invalid API key" } }, 401);
  }

  return next();
}
