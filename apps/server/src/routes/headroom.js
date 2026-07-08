import { Hono } from "hono";
import { getSettings, updateSettings } from "@9router/db";
import { getConsistentMachineId } from "@9router/shared/utils/machineId.js";
import {
  getHeadroomStatus,
  startHeadroomProxy,
  stopHeadroomProxy,
  getManagedPid,
  DEFAULT_HEADROOM_URL,
} from "../services/headroom.js";

const headroomRouter = new Hono();
const CLI_TOKEN_HEADER = "x-9r-cli-token";
const CLI_AUTH_SALT = "9r-cli-auth";

function isLocalRequest(c) {
  const host = c.req.header("host") || "";
  const bare = host.replace(/:\d+$/, "");
  return ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"].includes(bare);
}

async function getCliToken() {
  if (!getConsistentMachineId) return null;
  try {
    return await getConsistentMachineId(CLI_AUTH_SALT);
  } catch { return null; }
}

async function isAuthorizedStartStop(c) {
  if (isLocalRequest(c)) return true;
  const headerToken = c.req.header(CLI_TOKEN_HEADER);
  if (!headerToken) return false;
  const expected = await getCliToken();
  return expected === headerToken;
}

function forbidden(c, msg) {
  return c.json({ error: msg }, 403);
}

headroomRouter.get("/status", async (c) => {
  try {
    const settings = await getSettings().catch(() => null);
    const headroomUrl = (settings?.headroomUrl) || c.req.query("headroomUrl") || DEFAULT_HEADROOM_URL;
    const status = await getHeadroomStatus(headroomUrl);
    const managedPid = getManagedPid();
    return c.json({ ...status, url: headroomUrl, managedPid });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

headroomRouter.post("/start", async (c) => {
  if (!(await isAuthorizedStartStop(c)))
    return forbidden(c, "Local only: CLI token required");
  try {
    const { port } = await c.req.json().catch(() => ({}));
    const result = await startHeadroomProxy({ port });
    // Auto-enable compress user messages when starting proxy
    updateSettings({ headroomCompressUserMessages: true, headroomEnabled: true }).catch(() => {});
    return c.json(result);
  } catch (e) {
    const status = e.code === "NOT_INSTALLED" ? 400 : 500;
    return c.json({ error: e.message, code: e.code }, status);
  }
});

headroomRouter.post("/stop", async (c) => {
  if (!(await isAuthorizedStartStop(c)))
    return forbidden(c, "Local only: CLI token required");
  try {
    const result = stopHeadroomProxy();
    return c.json(result);
  } catch (e) {
    return c.json({ error: e.message, code: e.code }, 500);
  }
});

export default headroomRouter;
