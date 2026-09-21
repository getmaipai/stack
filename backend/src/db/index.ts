import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { dirname, join } from "node:path";
import { isCompiledBinary, stackDbPath } from "@/lib/paths";
import * as schema from "@/db/schema";

const sqlite = new Database(stackDbPath);
sqlite.exec("PRAGMA journal_mode = WAL");

export const db = drizzle(sqlite, { schema });
// drizzle's migrator reads the migrations folder with plain node:fs,
// which cannot see into a compiled binary's virtual filesystem. A
// compiled build's own migrations/ ships as a real sibling directory
// next to the binary instead (scripts/build-binary.sh copies it), so a
// compiled run resolves there; found live, running the first compiled
// build for HOME-STACK-01.
const migrationsFolder = isCompiledBinary ? join(dirname(process.execPath), "migrations") : join(import.meta.dir, "migrations");
try {
  migrate(db, { migrationsFolder });
} catch (error) {
  // A database from before the 2026-09-20 refocus has the product era's
  // tables and no journal in common with this one; there is no upgrade
  // path because nothing was ever installed. Say so instead of crashing
  // mid-migration.
  throw new Error(`The database at ${stackDbPath} does not match this Stack's schema (${(error as Error).message}). Move the data directory aside and start again.`);
}

export { sqlite };
