import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { and, eq, gt, lt } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { db } from "@/db";
import { meta, operator, sessions } from "@/db/schema";
import { dataDir } from "@/lib/paths";
import { identityHeaders } from "@/lib/identity";
import { getClientIp } from "@/lib/secretThrottle";
import type { AppEnv } from "@/types";

const OPERATOR_ID = "operator";
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const PEPPER_BYTES = 32;
const WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 20;
const MAX_BUCKETS = 5_000;
const OPERATOR_REQUIRED_KEY = "operator.required";
const GENERATOR_ACK_KEY = "try.generatorAcknowledged";

interface Bucket {
  fails: number;
  first: number;
  lockedUntil: number;
}

const throttleBuckets = new Map<string, Bucket>();

function pepperPath(): string {
  const keysDir = join(dataDir, "keys");
  if (!existsSync(keysDir)) mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  chmodSync(keysDir, 0o700);
  return join(keysDir, "pepper");
}

function getPepper(): Buffer {
  const path = pepperPath();
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(PEPPER_BYTES), { mode: 0o600, flag: "wx" });
  }
  chmodSync(path, 0o600);
  const pepper = readFileSync(path);
  if (pepper.byteLength !== PEPPER_BYTES) throw new Error("The operator pepper has an invalid length.");
  return pepper;
}

function applyPepper(password: string): string {
  return createHmac("sha256", getPepper()).update(password).digest("base64");
}

export function hasOperator(): boolean {
  return !!db.select({ id: operator.id }).from(operator).where(eq(operator.id, OPERATOR_ID)).get();
}

export function operatorRequired(): boolean {
  return db.select({ value: meta.value }).from(meta).where(eq(meta.key, OPERATOR_REQUIRED_KEY)).get()?.value === "true";
}

export function generatorAcknowledged(): boolean {
  return db.select({ value: meta.value }).from(meta).where(eq(meta.key, GENERATOR_ACK_KEY)).get()?.value === "true";
}

export function acknowledgeGenerator(): void {
  db.insert(meta).values({ key: GENERATOR_ACK_KEY, value: "true" })
    .onConflictDoUpdate({ target: meta.key, set: { value: "true" } }).run();
}

function setOperatorRequired(required: boolean): void {
  db.insert(meta).values({ key: OPERATOR_REQUIRED_KEY, value: String(required) })
    .onConflictDoUpdate({ target: meta.key, set: { value: String(required) } })
    .run();
}

export async function setOperatorPassword(password: string): Promise<void> {
  const now = new Date().toISOString();
  const passwordHash = await Bun.password.hash(applyPepper(password), {
    algorithm: "argon2id",
    memoryCost: 65536,
    timeCost: 3,
  });
  db.insert(operator)
    .values({ id: OPERATOR_ID, passwordHash, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: operator.id, set: { passwordHash, updatedAt: now } })
    .run();
  setOperatorRequired(true);
}

export async function verifyOperatorPassword(password: string): Promise<boolean> {
  const row = db.select({ passwordHash: operator.passwordHash }).from(operator).where(eq(operator.id, OPERATOR_ID)).get();
  if (!row) return false;
  return Bun.password.verify(applyPepper(password), row.passwordHash);
}

function throttleCheck(ip: string): { blocked: boolean; retryAfter: number } {
  const now = Date.now();
  const bucket = throttleBuckets.get(ip);
  if (!bucket) return { blocked: false, retryAfter: 0 };
  if (bucket.lockedUntil > now) return { blocked: true, retryAfter: Math.ceil((bucket.lockedUntil - now) / 1000) };
  if (now - bucket.first > WINDOW_MS) throttleBuckets.delete(ip);
  return { blocked: false, retryAfter: 0 };
}

function throttleFail(ip: string): void {
  const now = Date.now();
  let bucket = throttleBuckets.get(ip);
  if (!bucket || now - bucket.first > WINDOW_MS) {
    bucket = { fails: 0, first: now, lockedUntil: 0 };
    if (throttleBuckets.size >= MAX_BUCKETS) {
      for (const [key, value] of throttleBuckets) {
        if (value.lockedUntil <= now && now - value.first > WINDOW_MS) throttleBuckets.delete(key);
      }
    }
    throttleBuckets.set(ip, bucket);
  }
  bucket.fails++;
  if (bucket.fails >= MAX_FAILS) bucket.lockedUntil = now + WINDOW_MS;
}

export function operatorPasswordThrottle(ip: string): { blocked: boolean; retryAfter: number } {
  return throttleCheck(ip);
}

export function recordOperatorPasswordFailure(ip: string): void {
  throttleFail(ip);
}

export function resetOperatorPasswordThrottle(ip: string): void {
  throttleBuckets.delete(ip);
}

export function __resetOperatorThrottleForTests(): void {
  throttleBuckets.clear();
}

export function __resetOperatorForTests(): void {
  db.delete(sessions).run();
  db.delete(operator).run();
  db.delete(meta).where(eq(meta.key, OPERATOR_REQUIRED_KEY)).run();
  db.delete(meta).where(eq(meta.key, GENERATOR_ACK_KEY)).run();
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sessionExpiresAt(): Date {
  return new Date(Date.now() + SESSION_LIFETIME_MS);
}

export function issueOperatorSession(c: Context<AppEnv>): void {
  const token = generateSessionToken();
  const expiresAt = sessionExpiresAt();
  db.insert(sessions).values({
    id: crypto.randomUUID(),
    operatorId: OPERATOR_ID,
    tokenHash: hashSessionToken(token),
    userAgent: c.req.header("user-agent") ?? null,
    expiresAt: expiresAt.toISOString(),
    createdAt: new Date().toISOString(),
  }).run();
  setCookie(c, "stack_session", token, {
    httpOnly: true,
    sameSite: "Strict",
    secure: new URL(c.req.url).protocol === "https:",
    expires: expiresAt,
    path: "/",
  });
}

export function resolveOperatorSession(token: string): boolean {
  const now = new Date().toISOString();
  const session = db.select({ operatorId: sessions.operatorId })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, hashSessionToken(token)), gt(sessions.expiresAt, now)))
    .get();
  if (!session) return false;
  return session.operatorId === OPERATOR_ID && hasOperator();
}

export function pruneExpiredSessions(): void {
  db.delete(sessions).where(lt(sessions.expiresAt, new Date().toISOString())).run();
}

export function clearOperatorSession(c: Context<AppEnv>): void {
  const token = getCookie(c, "stack_session");
  if (token) db.delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(token))).run();
  deleteCookie(c, "stack_session", { path: "/" });
}

export function isOperatorSignedIn(c: Context<AppEnv>): boolean {
  const token = getCookie(c, "stack_session");
  return !!token && resolveOperatorSession(token);
}

export function isLoopbackRequest(c: Context): boolean {
  try {
    const hostname = new URL(c.req.url).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

export const requireOperator = createMiddleware<AppEnv>(async (c, next) => {
  if (!isOperatorSignedIn(c)) {
    for (const [name, value] of Object.entries(identityHeaders(null))) c.header(name, value);
    return c.json({ error: "Operator authentication required" }, 401);
  }
  await next();
});

export function requestIp(c: Context): string {
  return getClientIp(c);
}
