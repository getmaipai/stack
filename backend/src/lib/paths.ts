// The Stack's own data layout. `ensureDataDir` is core's; the layout
// (one data directory, the database, the models tree) is this product's.
import { ensureDataDir } from "@maipai/core/src/paths";
import { dirname, join, resolve } from "node:path";

// `import.meta.dir` is a real filesystem path under `bun run`, but
// resolves to `/$bunfs/root`, Bun's virtual in-binary path, once this
// module is part of a `bun build --compile` single-file executable -
// true for every module in the same compiled binary, not just this
// file's own. `db/index.ts` (the migrations folder) and this file's
// own default data directory below both need to know which mode
// they're in; this is the one place that says so, found live building
// HOME-STACK-01's first compiled binary.
export const isCompiledBinary = import.meta.dir.startsWith("/$bunfs");

// Real installs always set STACK_DATA_DIR explicitly (Home's installer
// writes it before ever starting the service); this fallback only
// matters for a bare `bun run`/compiled binary invoked by hand. A
// compiled binary's own `import.meta.dir` is the virtual `/$bunfs/root`
// path above, not a real directory three levels above anything - left
// unguarded, `resolve("/$bunfs/root", "../../..", "data")` collapses to
// the filesystem root's own `/data`, and `ensureDataDir` would try to
// create it there. `process.execPath` is a real path even compiled, so
// the fallback sits beside the binary instead, the same convention
// migrations/ and backend-src/ already use.
const defaultDataDir = isCompiledBinary ? join(dirname(process.execPath), "data") : resolve(import.meta.dir, "../../..", "data");
export const dataDir = resolve(process.env.STACK_DATA_DIR ?? defaultDataDir);
ensureDataDir(dataDir);

export const stackDbPath = join(dataDir, "stack.db");
export const modelsDir = join(dataDir, "models");
export const logsDir = join(dataDir, "logs");
export const keysDir = join(dataDir, "keys");
