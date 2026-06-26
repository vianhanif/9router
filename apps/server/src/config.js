import path from "node:path";
import os from "node:os";

export const PORT = parseInt(process.env.PORT || "20128", 10);
export const HOST = process.env.HOSTNAME || "0.0.0.0";
export const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), ".9router");
export const DB_PATH = path.join(DATA_DIR, "data.sqlite");
