// APP-KEYS-01 (Owner-approved 2026-11-28): keys a person makes on the admin page so other programs that speak the OpenAI format can call the
// Stack's model routes. Home keeps its own token and path (lib/requestGuard.ts); an app key is a second, smaller door beside it.
//
// Rules this file holds (docs/CREDENTIALS.md):
// - The key is shown once, when it is made. Only an HMAC-SHA256 of it is stored, under a pepper kept in keys/app-key-pepper (mode 600),
//   so a copied database cannot be used to call the Stack. The key is 256 random bits, so a fast keyed hash is the right tool (a slow
//   password hash would only slow every request).
// - A key is scoped: chat, vision, speech, models. It reaches only the routes of its scopes, never a control route, a job, or key management.
// - A key is revocable at once, and records its last use and use count.
// - A key never carries Home's privileges: no live priority, no full view of adult jobs (those need Home's token, which a key cannot send).
// - The key is never logged, returned again, or put in a health item.
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { appKeys } from "@/db/schema";
import { keysDir } from "@/lib/paths";
import { logger } from "@/lib/log";
import { raise, resolve as resolveHealth } from "@/lib/health";

export const APP_KEY_SCOPES = ["chat", "vision", "speech", "models"] as const;
export type AppKeyScope = typeof APP_KEY_SCOPES[number];
export const SCOPE_WORDS: Record<AppKeyScope, string> = {
  chat: "chat (text answers and coding)", vision: "vision (questions about pictures)", speech: "speech (speech to text and text to speech)", models: "models (the list of what is available)",
};
export const APP_KEY_PREFIX = "mpk_";
export const APP_KEY_SHAPE = /^mpk_[A-Za-z0-9_-]{43}$/;
const MAX_ACTIVE_KEYS = 50;
const NAME_MAX = 60;

export class AppKeyError extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly code: string, message: string) { super(message); this.name = "AppKeyError"; }
}

export interface AppKeyView {
  id: string; name: string; prefix: string; scopes: AppKeyScope[]; state: "active" | "revoked";
  created_at: string; created_by: string; last_used_at: string | null; use_count: number; revoked_at: string | null;
}
type Row = typeof appKeys.$inferSelect;

let pepper: Buffer | null = null;
function appKeyPepper(): Buffer {
  if (pepper) return pepper;
  const path = join(keysDir, "app-key-pepper");
  try { if (existsSync(path)) { const stored = readFileSync(path, "utf8").trim(); if (stored.length >= 32) return (pepper = Buffer.from(stored, "hex")); } } catch { /* make a new one below */ }
  const made = randomBytes(32);
  mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${made.toString("hex")}\n`, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
  return (pepper = made);
}
export const hashAppKey = (key: string): string => createHmac("sha256", appKeyPepper()).update(key).digest("hex");

const newId = () => `key_${randomBytes(5).toString("hex")}`;
function scopesOf(row: Row): AppKeyScope[] { try { return (JSON.parse(row.scopesJson) as string[]).filter((s): s is AppKeyScope => (APP_KEY_SCOPES as readonly string[]).includes(s)); } catch { return []; } }
function view(row: Row): AppKeyView {
  return { id: row.id, name: row.name, prefix: row.prefix, scopes: scopesOf(row), state: row.revokedAt ? "revoked" : "active", created_at: row.createdAt, created_by: row.createdBy, last_used_at: row.lastUsedAt, use_count: row.useCount, revoked_at: row.revokedAt };
}
function find(id: string): Row {
  const row = db.select().from(appKeys).where(eq(appKeys.id, id)).get();
  if (!row) throw new AppKeyError(404, "app_key_not_found", "That app key was not found. It may already have been removed; refresh the list.");
  return row;
}

export function listAppKeys(): AppKeyView[] { return db.select().from(appKeys).all().sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(view); }

export function createAppKey(input: { name: string; scopes: readonly string[]; by: "admin" | "home" }): { key: string; record: AppKeyView } {
  const name = input.name.replace(/\s+/g, " ").trim();
  if (!name) throw new AppKeyError(400, "app_key_name_required", "Give the key a name, such as the program or device that will use it (for example, Laptop notes app).");
  if (name.length > NAME_MAX || /[\u0000-\u001f]/.test(name)) throw new AppKeyError(400, "app_key_name_invalid", `Use a plain name of at most ${NAME_MAX} characters.`);
  const scopes = [...new Set(input.scopes)];
  if (scopes.length === 0) throw new AppKeyError(400, "app_key_scope_required", "Choose at least one scope for the key (chat, vision, speech or models), so it can do something.");
  const unknown = scopes.filter((s) => !(APP_KEY_SCOPES as readonly string[]).includes(s));
  if (unknown.length) throw new AppKeyError(400, "app_key_scope_unknown", `The Stack does not know the scope ${unknown.map((s) => `'${s}'`).join(", ")}. Choose from: ${APP_KEY_SCOPES.join(", ")}.`);
  const active = db.select().from(appKeys).where(isNull(appKeys.revokedAt)).all();
  if (active.some((r) => r.name.toLowerCase() === name.toLowerCase())) throw new AppKeyError(409, "app_key_name_taken", `A key named '${name}' already exists. Pick another name, or revoke the old key first.`);
  if (active.length >= MAX_ACTIVE_KEYS) throw new AppKeyError(409, "app_key_limit", `The Stack keeps at most ${MAX_ACTIVE_KEYS} active app keys. Revoke one you no longer use, then make the new key.`);
  const key = `${APP_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const row: Row = { id: newId(), name, prefix: key.slice(0, 8), hash: hashAppKey(key), scopesJson: JSON.stringify(scopes), createdAt: new Date().toISOString(), createdBy: input.by, lastUsedAt: null, useCount: 0, revokedAt: null };
  db.insert(appKeys).values(row).run();
  return { key, record: view(row) };
}

/** Revokes a key at once. A key already revoked stays as it was. */
export function revokeAppKey(id: string, by: "admin" | "home"): AppKeyView {
  const row = find(id);
  if (row.revokedAt) return view(row);
  const revokedAt = new Date().toISOString();
  db.update(appKeys).set({ revokedAt }).where(eq(appKeys.id, id)).run();
  void by;
  return view({ ...row, revokedAt });
}

/** Removes a revoked key's record from the list. An active key must be revoked first. */
export function forgetAppKey(id: string): void {
  const row = find(id);
  if (!row.revokedAt) throw new AppKeyError(409, "app_key_still_active", "Revoke the key first. A key that works cannot be removed from the list.");
  db.delete(appKeys).where(eq(appKeys.id, id)).run();
}

export type Verified = { ok: true; row: Row; scopes: AppKeyScope[] } | { ok: false; code: "app_key_unknown" } | { ok: false; code: "app_key_revoked"; row: Row };
export function verifyAppKey(presented: string): Verified {
  if (!APP_KEY_SHAPE.test(presented)) return { ok: false, code: "app_key_unknown" };
  const row = db.select().from(appKeys).where(eq(appKeys.hash, hashAppKey(presented))).get();
  if (!row) return { ok: false, code: "app_key_unknown" };
  if (row.revokedAt) return { ok: false, code: "app_key_revoked", row };
  return { ok: true, row, scopes: scopesOf(row) };
}

export function stampAppKeyUse(id: string, now = new Date()): void {
  const row = db.select({ useCount: appKeys.useCount }).from(appKeys).where(eq(appKeys.id, id)).get();
  if (row) db.update(appKeys).set({ lastUsedAt: now.toISOString(), useCount: row.useCount + 1 }).where(and(eq(appKeys.id, id), isNull(appKeys.revokedAt))).run();
}

// ---- Rate and queue: a key shares the machine with Home's requests and must never starve them. ----
// Per key: a requests-a-minute cap and a few at once. All keys together: fewer at once than the machine can take, so Home's interactive work
// always has room. Home's own requests never count here. A refused request gets 429 with Retry-After; nothing waits in a hidden queue.
const num = (name: string, fallback: number): number => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 && process.env[name] !== undefined && process.env[name] !== "" ? Math.floor(v) : fallback; };
export const appKeyLimits = {
  perMinute: (): number => num("STACK_APP_KEY_RATE_PER_MINUTE", 60),
  maxConcurrent: (): number => num("STACK_APP_KEY_MAX_CONCURRENT", 2),
  maxConcurrentAll: (): number => num("STACK_APP_KEY_MAX_CONCURRENT_ALL", 4),
};
const recent = new Map<string, number[]>();
const inFlight = new Map<string, number>();
let inFlightAll = 0;

export type Acquired = { ok: true; release: () => void } | { ok: false; code: "app_key_rate_limited" | "app_key_busy" | "app_keys_busy"; retryAfterSeconds: number };
export function tryAcquire(keyId: string, now = Date.now()): Acquired {
  const stamps = (recent.get(keyId) ?? []).filter((t) => now - t < 60_000);
  if (stamps.length >= appKeyLimits.perMinute()) { recent.set(keyId, stamps); return { ok: false, code: "app_key_rate_limited", retryAfterSeconds: Math.max(1, Math.ceil((stamps[0]! + 60_000 - now) / 1000)) }; }
  if ((inFlight.get(keyId) ?? 0) >= appKeyLimits.maxConcurrent()) return { ok: false, code: "app_key_busy", retryAfterSeconds: 2 };
  if (inFlightAll >= appKeyLimits.maxConcurrentAll()) return { ok: false, code: "app_keys_busy", retryAfterSeconds: 2 };
  stamps.push(now); recent.set(keyId, stamps);
  inFlight.set(keyId, (inFlight.get(keyId) ?? 0) + 1); inFlightAll += 1;
  let released = false;
  return { ok: true, release: () => {
    if (released) return; released = true;
    const left = (inFlight.get(keyId) ?? 1) - 1;
    if (left <= 0) inFlight.delete(keyId); else inFlight.set(keyId, left);
    inFlightAll = Math.max(0, inFlightAll - 1);
  } };
}

// ---- Audit and health ----
const lastLogged = new Map<string, number>();
/** One JSON line per use, in the Stack log with the other `admin.action.*` and request lines. Never the key, never a prompt. */
export function logAppKeyUse(row: Pick<Row, "id" | "name">, method: string, path: string): void {
  logger.appendLine(JSON.stringify({ event: "app_key.use", key_id: row.id, key_name: row.name, method, path }));
}
/** A refusal, logged at most once a minute per key and reason so a client that keeps retrying cannot flood the log. */
export function logAppKeyRefusal(keyId: string | null, code: string, method: string, path: string, now = Date.now()): void {
  const slot = `${keyId ?? "-"}:${code}`;
  if (now - (lastLogged.get(slot) ?? 0) < 60_000) return;
  lastLogged.set(slot, now);
  if (lastLogged.size > 500) lastLogged.clear();
  logger.appendLine(JSON.stringify({ event: "app_key.refused", key_id: keyId, code, method, path }));
}

/** Health codes are lower case with dots and dashes (the spec). */
export const healthCode = (kind: "throttled" | "revoked-in-use", id: string): string => `app-key-${kind}.${id.replace(/_/g, "-")}`;
const throttledAt = new Map<string, number>();
const THROTTLE_QUIET_MS = 5 * 60_000;
export function noteThrottled(row: Pick<Row, "id" | "name">, now = Date.now()): void {
  throttledAt.set(row.id, now);
  try {
    raise({ code: healthCode("throttled", row.id), severity: "warning", title: `App key '${row.name}' is sending too fast`,
      text: `A program using the app key '${row.name}' is sending requests faster than the Stack allows, so some were turned away to keep chat fast for everyone else.`,
      cause: "The key went over its requests-a-minute or at-once limit.",
    });
  } catch { /* the health list is a help, never a reason to fail a request */ }
}
export function noteAdmitted(row: Pick<Row, "id">, now = Date.now()): void {
  const at = throttledAt.get(row.id);
  if (at !== undefined && now - at > THROTTLE_QUIET_MS) { throttledAt.delete(row.id); try { resolveHealth(healthCode("throttled", row.id)); } catch { /* best effort */ } }
}
export function noteRevokedInUse(row: Pick<Row, "id" | "name">): void {
  try {
    raise({ code: healthCode("revoked-in-use", row.id), severity: "warning", title: `A program is still using the revoked key '${row.name}'`,
      text: `A program tried to use the app key '${row.name}' after it was revoked, and the Stack turned it away. If you still want that program to work, make a new key on the admin page and put it in the program.`,
      cause: "A client still holds a key that was revoked.",
    });
  } catch { /* best effort */ }
}

export function __resetAppKeysForTests(): void {
  db.delete(appKeys).run(); recent.clear(); inFlight.clear(); inFlightAll = 0; lastLogged.clear(); throttledAt.clear();
}
