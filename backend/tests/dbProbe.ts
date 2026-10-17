// Child process of db.test.ts: opens the Stack database that STACK_DATA_DIR
// names, lets @/db migrate it, and prints its tables and meta rows as JSON.
// It runs in its own process because @/db is a singleton opened on first
// import, so inside one `bun test` run another file may have opened it first.
const { db, sqlite } = await import("@/db");
const { meta } = await import("@/db/schema");
const tables = sqlite
  .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '__drizzle%' ORDER BY name")
  .all() as Array<{ name: string }>;
console.log(JSON.stringify({ tables: tables.map((row) => row.name), meta: db.select().from(meta).all() }));

export {};
