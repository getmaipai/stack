// The Stack's state: five tables. Settings values and small facts live
// in `meta`; a model's provenance and measured peaks in `models`; open
// and resolved health items in `health`; the one admin account in
// `admin`; its open sessions in `admin_sessions` (the token's sha256,
// never the token itself). Nothing else is stored (the governor's
// ledger and the event ring are in memory; history a person reads is
// Home's to keep).
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const admin = sqliteTable("admin", {
  id: integer("id").primaryKey(),
  passwordHash: text("password_hash").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const adminSessions = sqliteTable("admin_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  createdAt: text("created_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  remote: text("remote").notNull(),
});

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
  diskId: text("disk_id"),
});

export const disks = sqliteTable("disks", {
  id: text("id").primaryKey(), label: text("label").notNull(), rootPath: text("root_path").notNull().unique(),
  removable: integer("removable").notNull().default(0), createdAt: text("created_at").notNull(),
});

// STACK-CONNECTIONS-01: the connections the Stack manages (a paired Home, a custom MCP server). Records only; no secret value is stored
// here (`secret_ref` names a token in the secrets store). `paused` is the only stored state; connected / not seen lately are read from last_seen_at.
export const connections = sqliteTable("connections", {
  id: text("id").primaryKey(), kind: text("kind").notNull(), name: text("name").notNull(), reach: text("reach").notNull(),
  paused: integer("paused").notNull().default(0), lastSeenAt: text("last_seen_at"), lastUsedAt: text("last_used_at"), pairedAt: text("paired_at"),
  keyFingerprint: text("key_fingerprint"), endpointJson: text("endpoint_json"), toolsJson: text("tools_json"), secretRef: text("secret_ref"),
  createdAt: text("created_at").notNull(), provenance: text("provenance").notNull(), hlc: text("hlc").notNull(),
});

// APP-KEYS-01 (Owner-approved 2026-11-28): keys a person makes on the admin page for other programs that speak the OpenAI format.
// The key itself is never stored: `hash` is an HMAC-SHA256 of it under a pepper kept outside the database (keys/app-key-pepper), so a
// copied database cannot be used to call the Stack. `prefix` is the first characters, for telling keys apart in a list.
export const appKeys = sqliteTable("app_keys", {
  id: text("id").primaryKey(), name: text("name").notNull(), prefix: text("prefix").notNull(), hash: text("hash").notNull().unique(),
  scopesJson: text("scopes_json").notNull(), createdAt: text("created_at").notNull(), createdBy: text("created_by").notNull(),
  lastUsedAt: text("last_used_at"), useCount: integer("use_count").notNull().default(0), revokedAt: text("revoked_at"),
});

export const moveJobs = sqliteTable("move_jobs", {
  id: text("id").primaryKey(), modelId: text("model_id").notNull(), fromDisk: text("from_disk").notNull(),
  toDisk: text("to_disk").notNull(), state: text("state").notNull(), oldPath: text("old_path").notNull(),
  newPath: text("new_path").notNull(), bytesDone: integer("bytes_done").notNull().default(0),
  bytesTotal: integer("bytes_total").notNull().default(0), error: text("error"),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
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

export const mediaSegments = sqliteTable("media_segments", {
  fileSha256: text("file_sha256").primaryKey(), pipelineVersion: text("pipeline_version").notNull(),
  recordJson: text("record_json").notNull(), sourcePath: text("source_path").notNull(),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
});

export const learnedBumpers = sqliteTable("learned_bumpers", {
  showKey: text("show_key").primaryKey(),
  fingerprintsJson: text("fingerprints_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});
