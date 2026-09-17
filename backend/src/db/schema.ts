import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const models = sqliteTable("models", {
  id: text("id").primaryKey(),
  roles: text("roles").notNull(),
  source: text("source").notNull(),
  provenance: text("provenance").notNull(),
  revision: text("revision").notNull(),
  sha256: text("sha256"),
  sizeBytes: integer("size_bytes"),
  licence: text("licence"),
  engineRequirements: text("engine_requirements").notNull(),
  installedAt: text("installed_at"),
  verifiedAt: text("verified_at"),
  hostIdentity: text("host_identity"),
  firstBootAt: text("first_boot_at").notNull(),
  modelPath: text("model_path"),
});
