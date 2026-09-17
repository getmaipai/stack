import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { join } from "node:path";
import { stackDbPath } from "@/lib/paths";
import * as schema from "@/db/schema";

const sqlite = new Database(stackDbPath);
sqlite.exec("PRAGMA journal_mode = WAL");
const migrationsFolder = join(import.meta.dir, "migrations");

export const db = drizzle(sqlite, { schema });
migrate(db, { migrationsFolder });
sqlite.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '1') ON CONFLICT(key) DO UPDATE SET value = '1'");

export { sqlite };
