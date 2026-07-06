// Debug logging utility — only active with --debug flag (9ROUTER_DEBUG=1)
// Outputs are tagged with [DBG:tag] for easy grep/filter

function ts() {
  return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function dbg(tag, msg) {
  if (process.env["9ROUTER_DEBUG"] !== "1" && process.env["9ROUTER_DEBUG"] !== "true") return;
  console.log(`[${ts()}] 🐛 [DBG:${tag}] ${msg}`);
}

export const isDebugEnabled = () => process.env["9ROUTER_DEBUG"] === "1" || process.env["9ROUTER_DEBUG"] === "true";
