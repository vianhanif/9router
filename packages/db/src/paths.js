import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// Default DATA_DIR for standalone use. Next.js builds override via import.
const DEFAULT_DATA_DIR = path.join(os.homedir(), ".9router");
/** @type {string} */
export let DATA_DIR = process.env.DATA_DIR || DEFAULT_DATA_DIR;

// Allow override before DB init (used by Next.js build with @/ alias)
export function setDataDir(dir) {
  DATA_DIR = dir;
}

// Eagerly apply env override
if (process.env.DATA_DIR) {
  DATA_DIR = process.env.DATA_DIR;
}

export const DB_DIR = path.join(DATA_DIR, "db");
export const DATA_FILE = path.join(DB_DIR, "data.sqlite");
export const BACKUPS_DIR = path.join(DB_DIR, "backups");
export const LEGACY_FILES = {
  main: path.join(DATA_DIR, "db.json"),
  usage: path.join(DATA_DIR, "usage.json"),
  disabled: path.join(DATA_DIR, "disabledModels.json"),
  details: path.join(DATA_DIR, "request-details.json"),
};
export function ensureDirs() {
  for (const dir of [DATA_DIR, DB_DIR, BACKUPS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}
