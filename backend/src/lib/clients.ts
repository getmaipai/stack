import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { identityHeaders } from "@/lib/identity";
import { ROLE_IDS, type RoleId } from "@/roles";
import type { AppEnv, ClientRecord } from "@/types";

export interface UsageDelta {
  requests?: number;
  tokensIn?: number;
  tokensOut?: number;
  audioSeconds?: number;
  jobs?: number;
}

function parseRoles(value: string): RoleId[] {
  try {
    const roles = JSON.parse(value) as unknown;
    if (!Array.isArray(roles)) return [];
    return roles.filter((role): role is RoleId => typeof role === "string" && ROLE_IDS.includes(role as RoleId));
  } catch {
    return [];
  }
}

function toClientRecord(row: typeof clients.$inferSelect): ClientRecord {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    allowedRoles: parseRoles(row.allowedRoles),
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    revokedAt: row.revokedAt,
    requests: row.requests,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    audioSeconds: row.audioSeconds,
    jobs: row.jobs,
  };
}

export function hashClientKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function issueClient(name: string, allowedRoles: RoleId[]): string {
  const key = `mps_${randomBytes(32).toString("base64url")}`;
  const now = new Date().toISOString();
  db.insert(clients).values({
    id: `client-${crypto.randomUUID()}`,
    name,
    keyHash: hashClientKey(key),
    keyPrefix: key.slice(0, 8),
    allowedRoles: JSON.stringify([...new Set(allowedRoles)]),
    createdAt: now,
    lastSeenAt: null,
    revokedAt: null,
    requests: 0,
    tokensIn: 0,
    tokensOut: 0,
    audioSeconds: 0,
    jobs: 0,
  }).run();
  return key;
}

export function revokeClient(id: string): boolean {
  const existing = db.select({ id: clients.id }).from(clients).where(and(eq(clients.id, id), isNull(clients.revokedAt))).get();
  if (!existing) return false;
  db.update(clients).set({ revokedAt: new Date().toISOString() }).where(eq(clients.id, id)).run();
  return true;
}

export function resolveClient(bearer: string): ClientRecord | null {
  const row = db.select().from(clients).where(eq(clients.keyHash, hashClientKey(bearer))).get();
  if (!row || row.revokedAt) return null;
  const lastSeenAt = new Date().toISOString();
  db.update(clients).set({ lastSeenAt }).where(eq(clients.id, row.id)).run();
  return toClientRecord({ ...row, lastSeenAt });
}

export function recordUsage(id: string, delta: UsageDelta): void {
  const requests = delta.requests ?? 0;
  const tokensIn = delta.tokensIn ?? 0;
  const tokensOut = delta.tokensOut ?? 0;
  const audioSeconds = delta.audioSeconds ?? 0;
  const jobs = delta.jobs ?? 0;
  db.update(clients).set({
    requests: sql`${clients.requests} + ${requests}`,
    tokensIn: sql`${clients.tokensIn} + ${tokensIn}`,
    tokensOut: sql`${clients.tokensOut} + ${tokensOut}`,
    audioSeconds: sql`${clients.audioSeconds} + ${audioSeconds}`,
    jobs: sql`${clients.jobs} + ${jobs}`,
  }).where(eq(clients.id, id)).run();
}

export function listClients(): ClientRecord[] {
  return db.select().from(clients).all().map(toClientRecord);
}

function bearerToken(c: Context<AppEnv>): string | null {
  const header = c.req.header("authorization");
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

function unauthorized(c: Context<AppEnv>): Response {
  for (const [name, value] of Object.entries(identityHeaders(null))) c.header(name, value);
  return c.json({ error: "Client authentication required" }, 401);
}

export const requireClient = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearerToken(c);
  const client = token ? resolveClient(token) : null;
  if (!client) return unauthorized(c);
  c.set("client", client);
  await next();
});

export const requireClientOrOperator = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearerToken(c);
  if (token) {
    const client = resolveClient(token);
    if (!client) return unauthorized(c);
    c.set("client", client);
    await next();
    return;
  }
  const { isOperatorSignedIn } = await import("@/lib/operator");
  if (!isOperatorSignedIn(c)) return unauthorized(c);
  await next();
});
