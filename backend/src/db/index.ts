import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { join } from "node:path";
import { stackDbPath } from "@/lib/paths";
import * as schema from "@/db/schema";

const sqlite = new Database(stackDbPath);
sqlite.exec("PRAGMA journal_mode = WAL");

export const db = drizzle(sqlite, { schema });
try {
  migrate(db, { migrationsFolder: join(import.meta.dir, "migrations") });
} catch (error) {
  // A database from before the 2026-09-20 refocus has the product era's
  // tables and no journal in common with this one; there is no upgrade
  // path because nothing was ever installed. Say so instead of crashing
  // mid-migration.
  throw new Error(`The database at ${stackDbPath} does not match this Stack's schema (${(error as Error).message}). Move the data directory aside and start again.`);
}

export { sqlite };
