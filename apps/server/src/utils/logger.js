import { stats } from "../services/stats.js";

// ── Log levels ──────────────────────────────────────────
const LOG_LEVEL = (process.env["9ROUTER_DEBUG"] === "1" || process.env["9ROUTER_DEBUG"] === "true")
  ? "debug"
  : (process.env.LOG_LEVEL || "info").toLowerCase();

const LEVELS = {
  quiet: 0,  // request + error + summary only
  info: 1,   // + info + stream + usage
  debug: 2,  // + debug (🐛 lines)
};

const CURRENT = LEVELS[LOG_LEVEL] ?? 1;

// ── ANSI helpers ────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  gray: "\x1b[90m",
};

function time() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function indent(msg) {
  return `  ${msg}`;
}

function fmt(data) {
  if (!data) return "";
  if (typeof data === "string") return data;
  try { return JSON.stringify(data); } catch { return String(data); }
}

// ── Level-gated loggers ─────────────────────────────────

export function debug(tag, message, data) {
  if (CURRENT < 2) return;
  const d = data ? ` ${fmt(data)}` : "";
  console.log(indent(`${C.gray}[${time()}] 🐛 [${tag}] ${message}${d}${C.reset}`));
}

export function info(tag, message, data) {
  if (CURRENT < 1) return;
  const d = data ? ` ${fmt(data)}` : "";
  console.log(indent(`${C.bold}[${time()}]${C.reset} ℹ️  [${tag}] ${message}${d}`));
}

export function warn(tag, message, data) {
  if (CURRENT < 0) return;
  const d = data ? ` ${fmt(data)}` : "";
  console.log(indent(`${C.yellow}[${time()}] ⚠️  [${tag}] ${message}${d}${C.reset}`));
}

export function error(tag, message, data) {
  if (CURRENT < 0) return;
  const d = data ? ` ${fmt(data)}` : "";
  console.log(indent(`${C.red}[${time()}] ❌ [${tag}] ${message}${d}${C.reset}`));
}

// ── Request lifecycle ───────────────────────────────────

export function request({ method, path, model, combo, msgs, tools, extra } = {}) {
  const parts = [];
  if (method) parts.push(method);
  if (path) parts.push(path);
  if (combo) parts.push(`| ${combo}`);
  if (model) parts.push(`| ${model}`);
  if (msgs != null) parts.push(`| ${msgs} msgs`);
  if (tools) parts.push(`| ${tools} tools`);
  if (extra) parts.push(`| ${fmt(extra)}`);

  const sep = `${C.cyan}━━━ REQUEST ─────────────────────────────────────────────${C.reset}`;
  const line = `${C.cyan}📥 ${parts.join(" ")}${C.reset}`;
  console.log(`\n${sep}\n${indent(line)}`);

  return stats.requestStart({ method, path, model, combo, msgs, tools });
}

export function requestSummary({ id, status, duration, provider, model, tokensIn, tokensOut, cacheRead, reasoning, error } = {}) {
  const icon = status < 400 ? "📊" : "💥";
  const color = status < 400 ? C.green : C.red;
  const prov = provider ? provider.toUpperCase() : "";
  const durStr = duration != null ? `${C.dim}| ${duration}ms${C.reset}` : "";
  const tokStr = [];
  if (tokensIn != null) tokStr.push(`in=${tokensIn}`);
  if (tokensOut != null) tokStr.push(`out=${tokensOut}`);
  if (cacheRead) tokStr.push(`cache=${cacheRead}`);
  if (reasoning) tokStr.push(`reasoning=${reasoning}`);
  const tokPart = tokStr.length ? `${C.dim}| ${tokStr.join(" ")}${C.reset}` : "";
  const errPart = error ? ` ${C.red}❌ ${error}${C.reset}` : "";

  const tag = prov ? `${color}${prov}${C.reset}` : "";
  const modelTag = model ? `${C.cyan}${model}${C.reset}` : "";

  const summary = [
    indent(`${icon} ${color}${status}${C.reset} ${tag} ${modelTag} ${durStr} ${tokPart}${errPart}`),
  ].filter(Boolean).join("\n");

  console.log(summary);

  const sep = `${C.gray}${C.dim}━━━ END ────────────────────────────────────────────────${C.reset}`;
  console.log(`${sep}\n`);

  stats.requestEnd({ id, status, duration, provider, model, tokensIn, tokensOut, cacheRead, reasoning, error });
}

export function requestError({ id, status, error } = {}) {
  const line = `${C.red}💥 ${status} ${error}${C.reset}`;
  console.log(indent(line));
  const sep = `${C.red}${C.dim}━━━ ERROR ──────────────────────────────────────────────${C.reset}`;
  console.log(`${sep}\n`);
  stats.requestError({ id, status, error });
}

// ── Stream helpers (always shown at info level) ────────

export function stream(event, data) {
  if (CURRENT < 0) return;
  const d = data ? ` ${fmt(data)}` : "";
  console.log(indent(`🌊 [STREAM] ${event}${d}`));
}

// ── Response line (legacy, kept for compat) ────────────
export function response(status, duration, extra) {
  const icon = status < 400 ? "📤" : "💥";
  const d = extra ? ` ${fmt(extra)}` : "";
  console.log(indent(`${icon} ${status} (${duration}ms)${d}`));
}

// ── Mask ───────────────────────────────────────────────
export function maskKey(key) {
  if (!key || key.length < 8) return "***";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

// ── Deprecation shim: old request() callers (string args) ──
// Kept so chat.js etc keep working while we migrate.
const _oldRequest = request;
export { _oldRequest as requestLegacy };

