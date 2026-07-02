#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const esbuild = require("esbuild");

const cliDir = path.resolve(__dirname, "..");
const rootDir = path.resolve(cliDir, "..");
const cliAppDir = path.join(cliDir, "app");
const serverEntry = path.join(rootDir, "apps", "server", "src", "index.js");

async function main() {
  // Step 1: Sync version
  console.log("1️⃣  Syncing version...");
  const cliPkg = JSON.parse(fs.readFileSync(path.join(cliDir, "package.json"), "utf8"));
  const serverPkgPath = path.join(rootDir, "apps", "server", "package.json");
  const serverPkg = JSON.parse(fs.readFileSync(serverPkgPath, "utf8"));
  if (serverPkg.version !== cliPkg.version) {
    serverPkg.version = cliPkg.version;
    fs.writeFileSync(serverPkgPath, JSON.stringify(serverPkg, null, 2) + "\n");
  }
  console.log(`✅ Version: ${cliPkg.version}`);

  // Step 2: Clean old cli/app/
  console.log("2️⃣  Cleaning cli/app/...");
  if (fs.existsSync(cliAppDir)) {
    fs.rmSync(cliAppDir, { recursive: true, force: true });
  }
  fs.mkdirSync(cliAppDir, { recursive: true });
  console.log("✅ Cleaned");

  // Step 3: Bundle server with esbuild
  console.log("3️⃣  Bundling server...");
  if (!fs.existsSync(serverEntry)) {
    console.error(`❌ Server entry not found: ${serverEntry}`);
    process.exit(1);
  }
  await esbuild.build({
    entryPoints: [serverEntry],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    external: ["better-sqlite3", "sql.js", "bun:sqlite"],
    outfile: path.join(cliAppDir, "server.js"),
    sourcemap: true,
    keepNames: true,
    // Provide require() in ESM context for bundled CJS deps (e.g. undici)
    banner: {
      js: `import{createRequire}from"node:module";const require=createRequire(import.meta.url);`,
    },
    plugins: [{
      name: "external-old-monorepo-refs",
      setup(build) {
        // Old webpackIgnore imports from previous monorepo layout — leave as external
        build.onResolve({ filter: /^\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/src\// }, args => {
          return { external: true, path: args.path };
        });
      },
    }],
  });
  console.log("✅ Server bundled → cli/app/server.js");

  // Write package.json with type:module so Node treats server.js as ESM
  console.log("3b. Setting module type...");
  fs.writeFileSync(path.join(cliAppDir, "package.json"), JSON.stringify({ type: "module" }, null, 2) + "\n");
  console.log("✅ cli/app/package.json written");

  // Step 4: Build MITM server (unchanged)
  console.log("4️⃣  Building MITM server...");
  execSync("node scripts/buildMitm.js", { stdio: "inherit", cwd: cliDir });
  console.log("✅ MITM built");

  // Step 5: Summary
  console.log("\n✨ CLI build complete!");
  console.log(`📁 Output: ${cliAppDir}`);
}

main().catch(err => { console.error(err); process.exit(1); });
