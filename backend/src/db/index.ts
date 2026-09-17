import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, stackDbPath } from "@/lib/paths";
import * as schema from "@/db/schema";
import { migrationAssets } from "@/db/embeddedMigrations";

const sqlite = new Database(stackDbPath);
sqlite.exec("PRAGMA journal_mode = WAL");
async function resolveMigrationsFolder(): Promise<string> {
  const sourceFolder = join(import.meta.dir, "migrations");
  if (existsSync(join(sourceFolder, "meta", "_journal.json"))) return sourceFolder;
  const destination = join(dataDir, "migrations");
  mkdirSync(join(destination, "meta"), { recursive: true, mode: 0o700 });
  for (const [relative, asset] of migrationAssets) {
    const bytes = asset.startsWith("$bunfs/") ? await Bun.file(asset).bytes() : readFileSync(asset);
    writeFileSync(join(destination, relative), bytes, { mode: 0o600 });
  }
  return destination;
}

const migrationsFolder = await resolveMigrationsFolder();

export const db = drizzle(sqlite, { schema });
migrate(db, { migrationsFolder });
sqlite.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '1') ON CONFLICT(key) DO UPDATE SET value = '1'");

export { sqlite };
