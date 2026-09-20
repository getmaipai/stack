// The Stack's state: three tables. Settings values and small facts live
// in `meta`; a model's provenance and measured peaks in `models`; open
// and resolved health items in `health`. Nothing else is stored (the
// governor's ledger and the event ring are in memory; history a person
// reads is Home's to keep).
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
  measuredFootprintBytes: integer("measured_footprint_bytes"),
  measuredContextLength: integer("measured_context_length"),
});

export const health = sqliteTable("health", {
  code: text("code").primaryKey(),
  severity: text("severity").notNull(),
  title: text("title").notNull(),
  text: text("text").notNull(),
  since: text("since").notNull(),
  cause: text("cause").notNull(),
  fix: text("fix"),
  resolvedAt: text("resolved_at"),
  ignoredAt: text("ignored_at"),
});
