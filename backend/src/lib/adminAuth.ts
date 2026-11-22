// The one admin account and its sessions, behind the Stack's admin
// page. First run writes a one-time setup code to a 0600 file in the
// data directory; `setupAdmin` turns it into an argon2id password hash
// and deletes the file. A session stores only the sha256 of a random
// 256-bit token, lives 12 hours at most, and idles out after 30
// minutes. Every function takes a clock (defaulting to Date.now) so a
// test can run a whole session life in a few lines, and none of them
// prints or returns a password, a hash, or the setup code it checks.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { admin, adminSessions } from "@/db/schema";

const SETUP_CODE_FILE = "admin-setup-code";
const MIN_PASSWORD_LENGTH = 8;
const SETUP_MAX_ATTEMPTS = 5;
const SETUP_WINDOW_MS = 60 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const ARGON2 = { algorithm: "argon2id" as const, memoryCost: 19456, timeCost: 2 };

/** A failure the admin page can show in plain words. `code` is stable
 * (the page and the tests key off it); `retryAfterSeconds` is set only
 * on a rate limit, as the whole seconds until the limit clears. */
export class AdminError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AdminError";
  }
}

// Wrong-code and wrong-password counts are per process, not in the
// database: the page listens on loopback for one admin, so a restart
// of the Stack clears the counts, which is a fair reset.
const setupAttempts = new Map<string, number[]>();
const loginFailures = new Map<string, number[]>();

/** Wipes the rate-limit counts. Tests only. */
export function __resetAdminAuthRateLimitsForTests(): void {
  setupAttempts.clear();
  loginFailures.clear();
}

function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// 20 random bytes read 5 bits at a time: 160 bits, 32 characters, no
// padding.
function toBase32(bytes: Uint8Array): string {
  let out = "";
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += String.fromCharCode(BASE32.charCodeAt((value >>> (bits - 5)) & 31));
      bits -= 5;
    }
  }
  if (bits > 0) out += String.fromCharCode(BASE32.charCodeAt((value << (5 - bits)) & 31));
  return out;
}

function setupCodePath(dataDir: string): string {
  return join(dataDir, SETUP_CODE_FILE);
}

function within(timestamps: number[], now: number, windowMs: number): number[] {
  return timestamps.filter((at) => now - at < windowMs);
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

/** Writes a fresh 160-bit setup code (32 base32 characters) to
 * `<dataDir>/admin-setup-code` with mode 0600 and returns it. The
 * caller prints the code to the log once; this never does. */
export function createSetupCode(dataDir: string, _now: () => number = Date.now): string {
  const code = toBase32(randomBytes(20));
  const path = setupCodePath(dataDir);
  writeFileSync(path, code, { mode: 0o600 });
  chmodSync(path, 0o600);
  return code;
}

/** Checks a code against the file on disk in constant time. At most 5
 * wrong codes per hour per data directory: after that it throws
 * AdminError "too_many_attempts" with the seconds until the oldest try
 * falls out of the hour. A missing code file simply answers false. */
export function verifySetupCode(code: string, dataDir: string, now: () => number = Date.now): boolean {
  let stored: string;
  try {
    stored = readFileSync(setupCodePath(dataDir), "utf8");
  } catch {
    return false;
  }
  const attempt = now();
  if (constantTimeEqual(code, stored)) {
    setupAttempts.delete(dataDir);
    return true;
  }
  const attempts = within(setupAttempts.get(dataDir) ?? [], attempt, SETUP_WINDOW_MS);
  if (attempts.length >= SETUP_MAX_ATTEMPTS) {
    const oldest = attempts[0] ?? attempt;
    throw new AdminError(
      "too_many_attempts",
      "Too many wrong setup codes were entered. Wait a short while, then enter the code the Stack printed at first run.",
      Math.max(1, Math.ceil((oldest + SETUP_WINDOW_MS - attempt) / 1000)),
    );
  }
  attempts.push(attempt);
  setupAttempts.set(dataDir, attempts);
  return false;
}

/** Sets the one admin password from a valid setup code. The password
 * must be at least 8 characters; it is stored as an argon2id hash and
 * the code file is deleted. Throws AdminError if an admin already
 * exists, and "password_too_short" for a short password. */
export async function setupAdmin(code: string, password: string, dataDir: string, now: () => number = Date.now): Promise<void> {
  if (!verifySetupCode(code, dataDir, now)) {
    throw new AdminError("invalid_setup_code", "That setup code is not right. Enter the code the Stack printed at first run, or run the local reset command on this machine for a new one.");
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AdminError("password_too_short", "The password needs at least 8 characters. Choose a longer one.");
  }
  const existing = db.select().from(admin).get();
  if (existing) {
    throw new AdminError("admin_exists", "An admin account already exists. Sign in with its password, or run the local reset command on this machine.");
  }
  const passwordHash = await Bun.password.hash(password, ARGON2);
  const at = iso(now());
  db.insert(admin).values({ id: 1, passwordHash, createdAt: at, updatedAt: at }).run();
  rmSync(setupCodePath(dataDir), { force: true });
}

/** Signs the admin in with the password and a remote address (the
 * address the connection came from, used only to count failures). At
 * most 5 wrong passwords per 15 minutes per remote: after that it
 * throws AdminError "rate_limited" with the seconds until the oldest
 * failure falls out of the window. On success it opens a session and
 * returns the raw 256-bit token; only its sha256 is stored. */
export async function login(password: string, remote: string, now: () => number = Date.now): Promise<string> {
  const adminRow = db.select().from(admin).get();
  if (!adminRow) {
    throw new AdminError("no_admin", "No admin account is set up yet. Enter the one-time setup code the Stack printed at first run.");
  }
  const attempt = now();
  const failures = within(loginFailures.get(remote) ?? [], attempt, LOGIN_WINDOW_MS);
  if (failures.length >= LOGIN_MAX_FAILURES) {
    const oldest = failures[0] ?? attempt;
    throw new AdminError(
      "rate_limited",
      "Too many wrong passwords from this computer. Wait a short while, then try again.",
      Math.max(1, Math.ceil((oldest + LOGIN_WINDOW_MS - attempt) / 1000)),
    );
  }
  const ok = await Bun.password.verify(password, adminRow.passwordHash);
  if (!ok) {
    failures.push(attempt);
    loginFailures.set(remote, failures);
    throw new AdminError("wrong_password", "The password is wrong. Check it and try again.");
  }
  loginFailures.delete(remote);
  const token = randomBytes(32).toString("hex");
  const at = iso(attempt);
  db.insert(adminSessions)
    .values({ tokenHash: sha256Hex(token), createdAt: at, lastSeenAt: at, expiresAt: iso(attempt + SESSION_ABSOLUTE_MS), remote })
    .run();
  return token;
}

/** Checks a session token and keeps it alive. A session that is past
 * its 12-hour limit or has been idle for more than 30 minutes is
 * deleted and answers null; a live one gets its idle clock slid and
 * answers its expiry. The token is matched by its sha256 only. */
export async function validateSession(token: string, now: () => number = Date.now): Promise<{ expiresAt: number } | null> {
  const row = db.select().from(adminSessions).where(eq(adminSessions.tokenHash, sha256Hex(token))).get();
  if (!row) return null;
  const attempt = now();
  const lastSeen = Date.parse(row.lastSeenAt);
  const expiresAt = Date.parse(row.expiresAt);
  if (attempt >= expiresAt) {
    db.delete(adminSessions).where(eq(adminSessions.tokenHash, row.tokenHash)).run();
    return null;
  }
  if (attempt - lastSeen > SESSION_IDLE_MS) {
    db.delete(adminSessions).where(eq(adminSessions.tokenHash, row.tokenHash)).run();
    return null;
  }
  db.update(adminSessions).set({ lastSeenAt: iso(attempt) }).where(eq(adminSessions.tokenHash, row.tokenHash)).run();
  return { expiresAt };
}

/** Closes the session for a token. Unknown tokens are ignored. */
export async function logout(token: string, _now: () => number = Date.now): Promise<void> {
  db.delete(adminSessions).where(eq(adminSessions.tokenHash, sha256Hex(token))).run();
}

/** Changes the admin password. Needs a live session token, the current
 * password, and a new one of at least 8 characters. */
export async function changePassword(token: string, current: string, next: string, now: () => number = Date.now): Promise<void> {
  const session = await validateSession(token, now);
  if (!session) {
    throw new AdminError("invalid_session", "This sign-in has expired or was closed. Sign in again, then change the password.");
  }
  const adminRow = db.select().from(admin).get();
  if (!adminRow) {
    throw new AdminError("no_admin", "No admin account is set up yet.");
  }
  const ok = await Bun.password.verify(current, adminRow.passwordHash);
  if (!ok) {
    throw new AdminError("wrong_password", "The current password is wrong. Check it and try again.");
  }
  if (next.length < MIN_PASSWORD_LENGTH) {
    throw new AdminError("password_too_short", "The new password needs at least 8 characters. Choose a longer one.");
  }
  const passwordHash = await Bun.password.hash(next, ARGON2);
  db.update(admin).set({ passwordHash, updatedAt: iso(now()) }).where(eq(admin.id, 1)).run();
  // Every other sign-in ends, so a changed password also locks out a stolen session.
  db.delete(adminSessions).where(ne(adminSessions.tokenHash, sha256Hex(token))).run();
}

/** The local reset: deletes the admin account and every session, then
 * writes a fresh setup code and returns it, so first run starts over. */
export async function resetAdmin(dataDir: string, now: () => number = Date.now): Promise<string> {
  db.delete(adminSessions).run();
  db.delete(admin).run();
  return createSetupCode(dataDir, now);
}
