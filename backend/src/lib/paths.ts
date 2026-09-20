// The Stack's own data layout. `ensureDataDir` is core's; the layout
// (one data directory, the database, the models tree) is this product's.
import { ensureDataDir } from "@maipai/core/src/paths";
import { join, resolve } from "node:path";

export const dataDir = resolve(process.env.STACK_DATA_DIR ?? resolve(import.meta.dir, "../../..", "data"));
ensureDataDir(dataDir);

export const stackDbPath = join(dataDir, "stack.db");
export const modelsDir = join(dataDir, "models");
export const logsDir = join(dataDir, "logs");
export const keysDir = join(dataDir, "keys");
