import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const models = sqliteTable("models", {
  id: text("id").primaryKey(),
  nickname: text("nickname"),
  groupId: text("group_id"),
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

export const modelGroups = sqliteTable("model_groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  parentId: text("parent_id"),
  createdAt: text("created_at").notNull(),
});

export const modelUsage = sqliteTable("model_usage", {
  modelId: text("model_id").primaryKey(),
  requests: integer("requests").notNull().default(0),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  secondsLoaded: integer("seconds_loaded").notNull().default(0),
  peakMemoryBytes: integer("peak_memory_bytes").notNull().default(0),
  lastUsedAt: text("last_used_at"),
});

export const detected = sqliteTable("detected", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  version: text("version").notNull(),
  where: text("where").notNull(),
  couldHold: text("could_hold").notNull(),
  firstSeen: text("first_seen").notNull(),
  lastSeen: text("last_seen").notNull(),
  forgotten: integer("forgotten").notNull().default(0),
  adopted: integer("adopted").notNull().default(0),
  target: text("target"),
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

export const health = sqliteTable("health", {
  code: text("code").primaryKey(),
  severity: text("severity").notNull(),
  title: text("title").notNull(),
  text: text("text").notNull(),
  since: text("since").notNull(),
  cause: text("cause").notNull(),
  fix: text("fix"),
  learnMore: text("learn_more"),
  resolvedAt: text("resolved_at"),
  ignoredAt: text("ignored_at"),
});

export const usageSamples = sqliteTable("usage_samples", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: text("at").notNull(),
  ability: text("ability"),
  clientId: text("client_id"),
  modelId: text("model_id"),
  requests: integer("requests").notNull().default(0),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  jobs: integer("jobs").notNull().default(0),
});

export const memorySamples = sqliteTable("memory_samples", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: text("at").notNull(),
  totalBytes: integer("total_bytes").notNull(),
  freeBytes: integer("free_bytes").notNull(),
  availablePercent: integer("available_percent").notNull(),
  pressure: text("pressure").notNull(),
  loadedBytes: integer("loaded_bytes").notNull().default(0),
});

export const speedResults = sqliteTable("speed_results", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: text("at").notNull(),
  ability: text("ability"),
  modelId: text("model_id"),
  engine: text("engine"),
  firstTokenMs: integer("first_token_ms"),
  loadMs: integer("load_ms"),
  measuredFootprintBytes: integer("measured_footprint_bytes"),
  promptTps: integer("prompt_tps"),
  tokensPerSecond: integer("tokens_per_second"),
  contextLength: integer("context_length"),
});

export const checkRuns = sqliteTable("check_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: text("at").notNull(),
  ok: integer("ok").notNull(),
  results: text("results").notNull(),
  fitTogetherOk: integer("fit_together_ok").notNull(),
  fitTogetherReason: text("fit_together_reason"),
});

export const channels = sqliteTable("channels", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  name: text("name").notNull(),
  config: text("config").notNull(),
  verifiedAt: text("verified_at"),
  createdAt: text("created_at").notNull(),
  lastError: text("last_error"),
  lastSentAt: text("last_sent_at"),
  failureCount: integer("failure_count").notNull().default(0),
  pausedAt: text("paused_at"),
});

// Compatibility name for the old repair adapter and its route alias.
export const repairs = health;
