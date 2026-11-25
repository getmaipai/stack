// STACK-CONNECTIONS-01 (phase 1): the Stack's record of every connection it manages, a paired Home or a custom MCP server.
// Records only. The Stack does not start or call an MCP server here, and it stores no secret value: an mcp record holds `secret_ref`,
// an opaque name for a token (docs/CREDENTIALS.md: never in a table, never returned). Putting a token in the secrets store is a later phase.
import { eq } from "drizzle-orm";
import { createHlcClock } from "@maipai/core/src/hlc";
import { StackConnection, StackConnectionEndpoint } from "@maipai/spec/stack/ts/stack-connection.js";
import { db } from "@/db";
import { connections } from "@/db/schema";

/** A Home that has not been admitted for this long reads as "not seen lately". */
export const SEEN_LATELY_MS = 10 * 60_000;
const STAMP_EVERY_MS = 30_000;

const clock = createHlcClock("stackconn");
let seeded = false;
function nextHlc(): string {
  if (!seeded) { seeded = true; for (const row of db.select({ hlc: connections.hlc }).from(connections).all()) clock.seed(row.hlc); }
  return clock.next();
}

export class ConnectionError extends Error {
  constructor(readonly status: 400 | 404, message: string) { super(message); this.name = "ConnectionError"; }
}
type Row = typeof connections.$inferSelect;

function view(row: Row, now = Date.now()): StackConnection {
  const mcp = row.kind === "mcp";
  const state = row.paused ? "paused" : mcp ? "not_tested" : row.lastSeenAt && now - Date.parse(row.lastSeenAt) <= SEEN_LATELY_MS ? "connected" : "not_seen_lately";
  const out: Record<string, unknown> = { id: row.id, kind: row.kind, name: row.name, reach: row.reach, state, created_at: row.createdAt, provenance: row.provenance, hlc: row.hlc };
  if (mcp) {
    out.last_used_at = row.lastUsedAt; out.endpoint = JSON.parse(row.endpointJson ?? "null"); out.tools = JSON.parse(row.toolsJson ?? "[]"); out.secret_ref = row.secretRef;
  } else { out.last_seen_at = row.lastSeenAt; out.paired_at = row.pairedAt; out.key_fingerprint = row.keyFingerprint; }
  return StackConnection.parse(out);
}
function find(id: string): Row { const row = db.select().from(connections).where(eq(connections.id, id)).get(); if (!row) throw new ConnectionError(404, "That connection was not found. It may already have been removed; refresh the list."); return row; }
const newId = () => `conn_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;

export function listConnections(now = Date.now()): StackConnection[] { return db.select().from(connections).all().sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((row) => view(row, now)); }
export function getConnection(id: string): StackConnection { return view(find(id)); }

export interface AddMcpInput { name: string; endpoint: unknown; secret_ref?: string | null }
export function addMcpConnection(input: AddMcpInput): StackConnection {
  const name = input.name.trim();
  if (!name) throw new ConnectionError(400, "Give this connection a name, then try again.");
  if (name.length > 60) throw new ConnectionError(400, "Use a name of 60 characters or fewer.");
  const endpoint = StackConnectionEndpoint.safeParse(input.endpoint);
  if (!endpoint.success) throw new ConnectionError(400, "Say how to start the server (a command) or where it is (an http or https address), then try again.");
  if (input.secret_ref != null && !/^secret_[a-z0-9]{6,}$/.test(input.secret_ref)) throw new ConnectionError(400, "A secret is named, never pasted in. Leave it blank for now: storing a token comes in a later step.");
  if (db.select().from(connections).all().some((row) => row.kind === "mcp" && row.name.toLowerCase() === name.toLowerCase())) throw new ConnectionError(400, `A connection named ${name} already exists. Choose another name.`);
  const now = new Date().toISOString(); const id = newId();
  db.insert(connections).values({ id, kind: "mcp", name, reach: endpoint.data.type === "url" ? "url" : "command", endpointJson: JSON.stringify(endpoint.data), toolsJson: "[]", secretRef: input.secret_ref ?? null, createdAt: now, provenance: "stack:admin", hlc: nextHlc() }).run();
  return getConnection(id);
}
export function pauseConnection(id: string): StackConnection { find(id); db.update(connections).set({ paused: 1, hlc: nextHlc() }).where(eq(connections.id, id)).run(); return getConnection(id); }
export function resumeConnection(id: string): StackConnection { find(id); db.update(connections).set({ paused: 0, hlc: nextHlc() }).where(eq(connections.id, id)).run(); return getConnection(id); }
/** Phase 1: the record goes. Revoking a Home's SSH authorization (the OS helper) is a later phase and is not done here. */
export function removeConnection(id: string): void { find(id); db.delete(connections).where(eq(connections.id, id)).run(); }
export const TEST_NOT_AVAILABLE = "Testing a connection is not available yet. The Stack keeps this record, but it does not start or call the server in this version.";
export function testConnection(id: string): { ok: false; available: false; message: string } { find(id); return { ok: false, available: false, message: TEST_NOT_AVAILABLE }; }

let lastStamp = 0;
/** Called when a request carried Home's valid token: stamps `last_seen_at` on the Home record (made on first sight). At most once per 30 s unless `force`. A paused record stays paused. */
export function noteHomeSeen(now = Date.now(), force = false): void {
  if (!force && now - lastStamp < STAMP_EVERY_MS) return;
  lastStamp = now; const at = new Date(now).toISOString();
  const home = db.select().from(connections).all().find((row) => row.kind === "home");
  if (home) { db.update(connections).set({ lastSeenAt: at, hlc: nextHlc() }).where(eq(connections.id, home.id)).run(); return; }
  // The Stack has one Home token today, so there is one Home record. How it reaches the Stack is not visible from here: this_computer until the pairing helper reports it.
  db.insert(connections).values({ id: newId(), kind: "home", name: "Home", reach: "this_computer", lastSeenAt: at, pairedAt: at, createdAt: at, provenance: "stack:admission", hlc: nextHlc() }).run();
}
export function __resetConnectionsForTests(): void { lastStamp = 0; }
