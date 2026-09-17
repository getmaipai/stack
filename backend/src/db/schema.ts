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

export const operator = sqliteTable("operator", {
  id: text("id").primaryKey(),
  passwordHash: text("password_hash").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const clients = sqliteTable("clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  keyPrefix: text("key_prefix").notNull(),
  allowedRoles: text("allowed_roles").notNull(),
  createdAt: text("created_at").notNull(),
  lastSeenAt: text("last_seen_at"),
  revokedAt: text("revoked_at"),
  requests: integer("requests").notNull().default(0),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  audioSeconds: integer("audio_seconds").notNull().default(0),
  jobs: integer("jobs").notNull().default(0),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  operatorId: text("operator_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  userAgent: text("user_agent"),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const notifications = sqliteTable("notifications", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull(),
  level: text("level").notNull(),
  title: text("title").notNull(),
  data: text("data").notNull(),
  at: text("at").notNull(),
  readAt: text("read_at"),
  dismissedAt: text("dismissed_at"),
});

export const repairs = sqliteTable("repairs", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  detail: text("detail").notNull(),
  action: text("action").notNull(),
  level: text("level").notNull().default("passive"),
  openedAt: text("opened_at").notNull(),
  resolvedAt: text("resolved_at"),
});
