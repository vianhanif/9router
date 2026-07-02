import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Vite plugin: rewrite relative open-sse/ import paths in test files
// to use the @9router/core alias, since open-sse/ was moved to packages/core/.
function openSseImportRewrite() {
  return {
    name: "open-sse-rewrite",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith(".test.js") && !id.endsWith(".js")) return;
      // Replace ANY "?../(../)?open-sse/ pattern in string literals
      // with @9router/core/ — catches import(), vi.mock(), require(), etc.
      // The backref captures the quote-open prefix (handles both " and ')
      const newCode = code.replace(
        /(["'])(?:\.\.\/)+open-sse\//g,
        '$1@9router/core/'
      );
      if (newCode !== code) return newCode;
    },
  };
}

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["**/*.test.js"],
    // Don't scan into git worktrees nested under .claude/ — they carry their
    // own copies of the test files but lack an installed node_modules (open-sse,
    // etc.), which makes provider imports fail during collection.
    exclude: [
      "**/node_modules/**",
      "**/.claude/**",
      "**/dist/**",
      // Live/integration tests that need external services — excluded from CI
      "**/unit/mimo-free.live.test.js",
    ],
    // Allow many it.concurrent cases (real provider smoke runs ~50 providers in parallel)
    maxConcurrency: 60,
    // Suppress noisy console output from handlers under test
    silent: false,
  },
  plugins: [openSseImportRewrite()],
  resolve: {
    // Use array form so subpath aliases (e.g. "@/lib/db/index.js") resolve correctly.
    alias: [
      { find: /^open-sse\//, replacement: resolve(__dirname, "../packages/core") + "/" },
      { find: "@9router/core", replacement: resolve(__dirname, "../packages/core") },
      { find: /^@\//, replacement: resolve(__dirname, "../src") + "/" },
    ],
  },
});
