import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/db";
import { admin, adminSessions } from "@/db/schema";
import {
  AdminError,
  changePassword,
  createSetupCode,
  login,
  logout,
  resetAdmin,
  setupAdmin,
  validateSession,
  verifySetupCode,
  __resetAdminAuthRateLimitsForTests,
} from "@/lib/adminAuth";

// The preload pinned STACK_DATA_DIR to the run's scratch directory and
// opened the shared scratch database; this file uses that same
// directory and database and keeps both clean between tests.
const dataDir = process.env.STACK_DATA_DIR!;
const codePath = join(dataDir, "admin-setup-code");
const PASSWORD = "correct horse battery";
const WRONG_CODE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

let t: number;
let now: () => number;
const advance = (ms: number) => { t += ms; };

function clean() {
  db.delete(adminSessions).run();
  db.delete(admin).run();
  rmSync(codePath, { force: true });
}

async function withAdmin() {
  const code = createSetupCode(dataDir, now);
  await setupAdmin(code, PASSWORD, dataDir, now);
}

beforeEach(() => {
  clean();
  t = 1_700_000_000_000;
  now = () => t;
  __resetAdminAuthRateLimitsForTests();
});

afterEach(clean);

test("setup: a valid code stores an argon2id hash and deletes the 0600 code file", async () => {
  const code = createSetupCode(dataDir, now);
  expect(code).toMatch(/^[A-Z2-7]{32}$/);
  expect(statSync(codePath).mode & 0o777).toBe(0o600);
  expect(verifySetupCode(code, dataDir, now)).toBe(true);
  await setupAdmin(code, PASSWORD, dataDir, now);
  const row = db.select().from(admin).get();
  expect(row).not.toBeNull();
  expect(row!.id).toBe(1);
  expect(row!.passwordHash.startsWith("$argon2id$")).toBe(true);
  expect(row!.passwordHash.includes(PASSWORD)).toBe(false);
  expect(row!.createdAt).toBe(new Date(t).toISOString());
  expect(existsSync(codePath)).toBe(false);
});

test("setup: a wrong code is rejected, and a second setup is refused once an admin exists", async () => {
  const code = createSetupCode(dataDir, now);
  expect(verifySetupCode(WRONG_CODE, dataDir, now)).toBe(false);
  expect(db.select().from(admin).get()).toBeUndefined();
  await setupAdmin(code, PASSWORD, dataDir, now);
  writeFileSync(codePath, code, { mode: 0o600 });
  await expect(setupAdmin(code, PASSWORD, dataDir, now)).rejects.toMatchObject({ code: "admin_exists" });
});

test("setup: a short password is refused and stores nothing", async () => {
  const code = createSetupCode(dataDir, now);
  await expect(setupAdmin(code, "elephan", dataDir, now)).rejects.toMatchObject({ code: "password_too_short" });
  expect(db.select().from(admin).get()).toBeUndefined();
  expect(existsSync(codePath)).toBe(true);
});

test("setup: the sixth wrong code within the hour throws too_many_attempts with a retry time", () => {
  createSetupCode(dataDir, now);
  for (let i = 0; i < 5; i++) {
    advance(1000);
    expect(verifySetupCode(WRONG_CODE, dataDir, now)).toBe(false);
  }
  advance(1000);
  let error: unknown;
  try {
    verifySetupCode(WRONG_CODE, dataDir, now);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(AdminError);
  expect(error).toMatchObject({ code: "too_many_attempts" });
  expect((error as AdminError).retryAfterSeconds).toBe(3595);
});

test("login: the right password returns a 64 hex character token, storing only its sha256", async () => {
  await withAdmin();
  const token = await login(PASSWORD, "127.0.0.1", now);
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  const sessions = db.select().from(adminSessions).all();
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
  expect(sessions[0]!.remote).toBe("127.0.0.1");
  expect(sessions[0]!.expiresAt).toBe(new Date(t + 12 * 3600 * 1000).toISOString());
});

test("login: before setup there is no admin, and a wrong password says so", async () => {
  await expect(login(PASSWORD, "127.0.0.1", now)).rejects.toMatchObject({ code: "no_admin" });
  await withAdmin();
  await expect(login("wrong password here", "127.0.0.1", now)).rejects.toMatchObject({ code: "wrong_password" });
  expect(db.select().from(adminSessions).all()).toHaveLength(0);
});

test("login: six wrong passwords from one remote are rate limited, and the limit clears after 15 minutes", async () => {
  await withAdmin();
  for (let i = 0; i < 5; i++) {
    advance(60 * 1000);
    await expect(login("wrong password here", "127.0.0.1", now)).rejects.toMatchObject({ code: "wrong_password" });
  }
  advance(60 * 1000);
  let error: unknown;
  try {
    await login("wrong password here", "127.0.0.1", now);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(AdminError);
  expect(error).toMatchObject({ code: "rate_limited" });
  // The oldest failure was 5 minutes ago; the window is 15, so 10 remain.
  expect((error as AdminError).retryAfterSeconds).toBe(10 * 60);
  // A different remote is not limited by this one's failures.
  const token = await login(PASSWORD, "192.0.2.10", now);
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  // After the first failure falls out of the 15 minute window, login works again.
  advance(600 * 1000);
  const again = await login(PASSWORD, "127.0.0.1", now);
  expect(again).toMatch(/^[0-9a-f]{64}$/);
});

test("session: an idle session expires after 30 minutes and slides while it is used", async () => {
  await withAdmin();
  const token = await login(PASSWORD, "127.0.0.1", now);
  advance(29 * 60 * 1000);
  expect(await validateSession(token, now)).not.toBeNull();
  // 58 minutes of total age, but 29 since the last check: the check slid it.
  advance(29 * 60 * 1000);
  expect(await validateSession(token, now)).not.toBeNull();
  expect(db.select().from(adminSessions).all()).toHaveLength(1);
  // 31 minutes idle now: gone.
  advance(31 * 60 * 1000);
  expect(await validateSession(token, now)).toBeNull();
  expect(db.select().from(adminSessions).all()).toHaveLength(0);
});

test("session: a session dies at its 12 hour limit even while it is used", async () => {
  await withAdmin();
  const token = await login(PASSWORD, "127.0.0.1", now);
  // 24 checks 29 minutes apart (each within the idle limit): 696 minutes in.
  for (let i = 0; i < 24; i++) {
    advance(29 * 60 * 1000);
    expect(await validateSession(token, now)).not.toBeNull();
  }
  // One more 29 minutes is only 29 minutes idle, but 725 minutes old: the
  // absolute 12 hour limit ends it.
  advance(29 * 60 * 1000);
  expect(await validateSession(token, now)).toBeNull();
  expect(db.select().from(adminSessions).all()).toHaveLength(0);
});

test("session: an unknown token is null, and logout closes the session", async () => {
  await withAdmin();
  const token = await login(PASSWORD, "127.0.0.1", now);
  expect(await validateSession("0".repeat(64), now)).toBeNull();
  await logout(token, now);
  expect(await validateSession(token, now)).toBeNull();
  expect(db.select().from(adminSessions).all()).toHaveLength(0);
});

test("password: changePassword needs a live session, the current password, and a long new one", async () => {
  await withAdmin();
  const token = await login(PASSWORD, "127.0.0.1", now);
  await expect(changePassword(token, "wrong password here", "a new long password", now)).rejects.toMatchObject({ code: "wrong_password" });
  await expect(changePassword(token, PASSWORD, "short", now)).rejects.toMatchObject({ code: "password_too_short" });
  await changePassword(token, PASSWORD, "a new long password", now);
  await expect(login(PASSWORD, "127.0.0.1", now)).rejects.toMatchObject({ code: "wrong_password" });
  const token2 = await login("a new long password", "127.0.0.1", now);
  expect(token2).toMatch(/^[0-9a-f]{64}$/);
  advance(31 * 60 * 1000);
  // The old token idled out, so the change is refused from it.
  await expect(changePassword(token, "a new long password", "yet another password", now)).rejects.toMatchObject({ code: "invalid_session" });
  const token3 = await login("a new long password", "127.0.0.1", now);
  await changePassword(token3, "a new long password", "yet another password", now);
  await expect(login("a new long password", "127.0.0.1", now)).rejects.toMatchObject({ code: "wrong_password" });
  await expect(login("yet another password", "127.0.0.1", now)).resolves.toMatch(/^[0-9a-f]{64}$/);
});

test("reset: deleting the admin and sessions starts first run over with a fresh code", async () => {
  await withAdmin();
  const token = await login(PASSWORD, "127.0.0.1", now);
  expect(await validateSession(token, now)).not.toBeNull();
  const code = await resetAdmin(dataDir, now);
  expect(db.select().from(admin).get()).toBeUndefined();
  expect(db.select().from(adminSessions).all()).toHaveLength(0);
  expect(await validateSession(token, now)).toBeNull();
  expect(existsSync(codePath)).toBe(true);
  expect(verifySetupCode(code, dataDir, now)).toBe(true);
  await setupAdmin(code, "a brand new password", dataDir, now);
  await expect(login(PASSWORD, "127.0.0.1", now)).rejects.toMatchObject({ code: "wrong_password" });
  await expect(login("a brand new password", "127.0.0.1", now)).resolves.toMatch(/^[0-9a-f]{64}$/);
  expect(existsSync(codePath)).toBe(false);
});

test("setup: a wrong setup code never creates the admin, even with a long password", async () => {
  createSetupCode(dataDir, now);
  await expect(setupAdmin("NOTTHECODE", PASSWORD, dataDir, now)).rejects.toMatchObject({ code: "invalid_setup_code" });
  await expect(login(PASSWORD, "192.0.2.1", now)).rejects.toMatchObject({ code: "no_admin" });
});
