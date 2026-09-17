import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const dataDir = resolve(
  process.env.STACK_DATA_DIR ?? resolve(import.meta.dir, "../../..", "data"),
);

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true, mode: 0o700 });

export const stackDbPath = join(dataDir, "stack.db");
export const modelsDir = join(dataDir, "models");
