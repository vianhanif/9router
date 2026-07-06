// ── Live TUI Dashboard ──────────────────────────────────────
// Zero-dep ANSI terminal. Connects to running 9router server
// via /api/stats and /health endpoints. Hit 'q' to quit.

const path = require("path");
const fs = require("fs");

const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));

let HOST = process.env.HOST || "localhost";
let PORT = 20128;
let LOG_OFFSET = 0;
let LOG_ENTRIES = [];
let STATS = {};
let STATUS_SUMMARY = null;
let HEALTH = {};
let LAST_ERROR = null;
let INTERVAL = null;
let KEYS = [];

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  rev: "\x1b[7m",
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgBlack: "\x1b[40m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
  bgCyan: "\x1b[46m",
  bgGray: "\x1b[47m",
  bgDarkGray: "\x1b[100m",
};

function normUrl(host, port) {
  const h = host === "0.0.0.0" ? "localhost" : host;
  return `http://${h}:${port}`;
}

async function fetchJSON(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    return { ok: res.ok, data };
  } catch (e) {
    return { ok: false, data: null, error: e.message || String(e) };
  }
}

async function poll() {
  const base = normUrl(HOST, PORT);
  const [statsRes, healthRes, logRes, statusRes] = await Promise.all([
    fetchJSON(`${base}/api/stats/info`),
    fetchJSON(`${base}/health`),
    fetchJSON(`${base}/api/stats/log?limit=50`),
    fetchJSON(`${base}/api/status/summary`),
  ]);

  if (statsRes.ok) STATS = statsRes.data;
  else LAST_ERROR = "Stats unavailable";
  if (healthRes.ok) HEALTH = healthRes.data;
  else if (!statsRes.ok) LAST_ERROR = "Server unreachable";
  if (logRes.ok && logRes.data) LOG_ENTRIES = logRes.data;
  if (statusRes.ok) STATUS_SUMMARY = statusRes.data;

  render();
}

function fmtUptime(ms) {
  if (!ms) return "-";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s % 60}s`;
}

function fmtNum(n) {
  if (n == null) return "0";
  return n.toLocaleString();
}

function fmtDuration(ms) {
  if (ms == null) return "-";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function onOff(v) {
  return v ? `${C.green}ON${C.reset}` : `${C.red}OFF${C.reset}`;
}

function render() {
  const { stdout } = process;
  const cols = Math.min(stdout.columns || 100, 120);
  const rows = (stdout.rows || 40) - 1;
  const lines = [];
  const s = STATUS_SUMMARY;

  // Header
  const serverUrl = `http://${HOST}:${PORT}`;
  lines.push(`${C.cyan}━━━ ${C.bold}9Router Dashboard ${C.reset}${C.dim}v${PKG.version}${C.reset} ${C.cyan}━━━━ ${serverUrl} ${C.cyan}━━━━━${C.reset}`);

  // Server status bar
  const up = fmtUptime(STATS.uptime);
  const statusColor = LAST_ERROR && !STATS.uptime ? C.red : C.green;
  const statusText = LAST_ERROR && !STATS.uptime ? "DOWN" : "UP";
  const active = STATS.activeRequests ?? "?";
  const total = fmtNum(STATS.totalRequests);
  const errors = fmtNum(STATS.errorCount);
  lines.push(`  ${statusColor}●${C.reset} ${statusText}  ${C.dim}Uptime:${C.reset} ${up}  ${C.cyan}A:${C.reset}${active}  ${C.cyan}T:${C.reset}${total}  ${C.red}E:${C.reset}${errors}${LAST_ERROR ? `  ${C.red}${LAST_ERROR}${C.reset}` : ""}`);

  // ── Token Saver Tools ──
  if (s && s.tokenSavers) {
    const ts = s.tokenSavers;
    lines.push(`  ${C.bold}Token Savers${C.reset}`);
    const hr = ts.headroom;
    const hrStatus = hr.enabled ? `${C.green}●${C.reset} proxy ${hr.status}` : `${C.dim}inactive${C.reset}`;
    lines.push(`  ${C.cyan}HEADROOM${C.reset} ${onOff(hr.enabled)}  ${C.dim}url:${C.reset} ${hr.url || "-"}  ${C.dim}compress:${C.reset} ${onOff(hr.compressUserMessages)}  ${hrStatus}`);
    lines.push(`  ${C.cyan}CAVEMAN ${C.reset} ${onOff(ts.caveman.enabled)}  ${C.dim}level:${C.reset} ${ts.caveman.level}`);
    lines.push(`  ${C.cyan}PONYTAIL${C.reset} ${onOff(ts.ponytail.enabled)}  ${C.dim}level:${C.reset} ${ts.ponytail.level}`);
    lines.push(`  ${C.cyan}RTK     ${C.reset} ${onOff(ts.rtk.enabled)}`);
  }

  // ── Providers ──
  if (s && s.providers && s.providers.length > 0) {
    lines.push(`  ${C.bold}Providers${C.reset}`);
    for (const p of s.providers) {
      const accts = p.accounts > 1 ? ` ${C.dim}(${p.accounts} accts)${C.reset}` : "";
      const auths = p.authTypes.length ? ` ${C.dim}[${p.authTypes.join(",")}]${C.reset}` : "";
      lines.push(`  ${C.cyan}${truncate(p.id, 14).padEnd(14)}${C.reset}${accts}${auths}`);
    }
  } else {
    lines.push(`  ${C.bold}Providers${C.reset}`);
    lines.push(`  ${C.dim}No provider connections${C.reset}`);
  }

  // ── Combos ──
  if (s && s.combos && s.combos.length > 0) {
    lines.push(`  ${C.bold}Combos${C.reset}`);
    for (const combo of s.combos) {
      const kind = combo.kind !== "llm" ? ` ${C.dim}(${combo.kind})${C.reset}` : "";
      const models = combo.models.slice(0, 5).join(", ");
      const more = combo.models.length > 5 ? `${C.dim} +${combo.models.length - 5} more${C.reset}` : "";
      lines.push(`  ${C.magenta}${combo.name}${C.reset}${kind}  ${C.dim}${combo.modelCount} models:${C.reset} ${models}${more}`);
    }
  }

  // ── Provider usage (compact) ──
  const usage = STATS.providerUsage;
  if (usage && Object.keys(usage).length > 0) {
    lines.push(`  ${C.bold}Usage${C.reset}`);
    const sorted = Object.entries(usage).sort((a, b) => b[1].requests - a[1].requests);
    for (const [prov, u] of sorted) {
      const p = truncate(prov, 10).padEnd(10);
      lines.push(`  ${C.cyan}${p}${C.reset} ${C.green}in:${fmtNum(u.in)}${C.reset} ${C.yellow}out:${fmtNum(u.out)}${C.reset}${u.cacheRead > 0 ? ` ${C.dim}cache:${fmtNum(u.cacheRead)}${C.reset}` : ""} ${C.magenta}${fmtNum(u.requests)} reqs${C.reset}`);
    }
  }

  // ── Recent log entries ──
  lines.push(`  ${C.bold}Recent Requests${C.reset}`);
  const maxLogRows = Math.max(3, rows - lines.length - 4);
  if (LOG_ENTRIES.length === 0) {
    lines.push(`  ${C.dim}No recent requests${C.reset}`);
  } else {
    const start = Math.max(0, LOG_ENTRIES.length - maxLogRows - LOG_OFFSET);
    const end = Math.max(start, LOG_ENTRIES.length - LOG_OFFSET);
    const visible = LOG_ENTRIES.slice(start, end).reverse();
    for (const entry of visible) {
      const t = new Date(entry.time).toLocaleTimeString("en-US", { hour12: false });
      let line = `  ${C.dim}${t}${C.reset}`;
      if (entry.type === "start") {
        line += ` ${C.cyan}${entry.method || "?"} ${entry.path || "?"}${C.reset}`;
        if (entry.model) line += ` ${C.dim}|${C.reset} ${entry.model}`;
        if (entry.combo) line += ` ${C.dim}|${C.reset} ${C.magenta}${entry.combo}${C.reset}`;
        if (entry.msgs) line += ` ${C.dim}| ${entry.msgs} msgs${C.reset}`;
      } else if (entry.type === "end") {
        const ec = entry.status < 400 ? C.green : C.red;
        line += ` ${ec}${entry.status}${C.reset}`;
        if (entry.duration) line += ` ${C.dim}${fmtDuration(entry.duration)}${C.reset}`;
        if (entry.provider) line += ` ${C.dim}|${C.reset} ${entry.provider.toUpperCase()}`;
        if (entry.model) line += ` ${C.dim}|${C.reset} ${truncate(entry.model, 22)}`;
        if (entry.tokensOut != null) line += ` ${C.dim}| out=${fmtNum(entry.tokensOut)}${C.reset}`;
        if (entry.tokensIn != null) line += ` ${C.dim}in=${fmtNum(entry.tokensIn)}${C.reset}`;
        if (entry.cacheRead) line += ` ${C.dim}cache=${fmtNum(entry.cacheRead)}${C.reset}`;
      } else if (entry.type === "error") {
        line += ` ${C.red}${entry.status || "ERR"} ${entry.error || ""}${C.reset}`;
      }
      lines.push(truncate(line, cols - 1));
    }
  }

  // Footer
  const pad = rows - lines.length - 1;
  for (let i = 0; i < Math.max(0, pad); i++) lines.push("");
  const footerText = ` [q] quit  ▲▼ scroll  auto-refresh 2s `;
  lines.push(`${C.rev}${C.black}${footerText.padEnd(cols - 1)}${C.reset}`);

  const output = "\x1b[?25l\x1b[H" + lines.slice(0, rows).join("\n");
  stdout.write(output);
}

function restoreTerminal() {
  try {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  } catch {}
  process.stdout.write("\x1b[?25h\x1b[J\n");
}

function onKey(chunk) {
  const key = chunk.toString();
  if (key === "q" || key === "\u0003") {
    // q or Ctrl+C
    clearInterval(INTERVAL);
    restoreTerminal();
    process.exit(0);
  }
  if (key === "\u001b[A") {
    // Up arrow - scroll log back
    LOG_OFFSET = Math.min(LOG_OFFSET + 3, Math.max(0, LOG_ENTRIES.length - 5));
  }
  if (key === "\u001b[B") {
    // Down arrow - scroll log forward
    LOG_OFFSET = Math.max(0, LOG_OFFSET - 3);
  }
}

async function startDashboard(opts) {
  if (opts) {
    if (opts.port) PORT = opts.port;
    if (opts.host) HOST = opts.host;
  }

  // immediate feedback
  process.stdout.write(`\x1b[36m━━━ 9Router Dashboard v${PKG.version}${C.reset} — connecting to ${HOST}:${PORT}...\n`);

  // Setup raw stdin for keypresses (before first poll so it's ready)
  try {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onKey);
  } catch {
    // Non-TTY: just poll without keyboard control
  }

  process.on("SIGINT", () => {
    clearInterval(INTERVAL);
    restoreTerminal();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    clearInterval(INTERVAL);
    restoreTerminal();
    process.exit(0);
  });

  // First render — poll catches unreachable server and shows DOWN state
  await poll();
  INTERVAL = setInterval(poll, 2000);

  // Keep alive
  return new Promise(() => {});
}

module.exports = { startDashboard };
