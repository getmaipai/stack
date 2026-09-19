import { beforeAll, describe, expect, it } from "bun:test";
import { app } from "@/app";
import { issueClient, resolveClient } from "@/lib/clients";
import { __resetOperatorForTests } from "@/lib/operator";
import { ROLE_IDS } from "@/roles";

const openPaths = ["/stack/v1/operator", "/stack/v1/operator/setup", "/stack/v1/operator/login"];
const base = "http://localhost:4000";

async function request(path: string, init?: RequestInit, urlBase = base) {
  const response = await app.request(new Request(new URL(path, urlBase).toString(), init));
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: response.status, body, headers: response.headers };
}

describe("operator session required on /stack/v1", () => {
  let v1Paths: string[] = [];
  let lanPaths: string[] = [];

  beforeAll(async () => {
    __resetOperatorForTests();
    const doc = (await (await app.request(new Request(new URL("/api/openapi.json", base).toString()))).json()) as { paths: Record<string, unknown> };
    v1Paths = Object.keys(doc.paths).filter((p) => p.startsWith("/stack/v1/") && !openPaths.includes(p));
    lanPaths = v1Paths.filter(
      (p) =>
        p === "/stack/v1/models" ||
        p === "/stack/v1/hardware" ||
        p === "/stack/v1/settings" ||
        p === "/stack/v1/events" ||
        p === "/stack/v1/library",
    );
  });

  it("exposes a healthy /healthz without a session", async () => {
    const { status, body } = await request("/healthz");
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true });
  });

  it("answers the three open operator paths without a session", async () => {
    const state = await request("/stack/v1/operator");
    expect(state.status).toBe(200);
    expect(state.body).toEqual({ state: "setupRequired", required: true, loopback: true });

    const badLogin = await request("/stack/v1/operator/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    expect(badLogin.status).toBe(401);
    expect(badLogin.body).toEqual({ error: "Invalid operator password" });

    const setup = await request("/stack/v1/operator/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "op-pass" }),
    });
    expect(setup.status).toBe(201);
    expect(setup.body).toEqual({ state: "signedIn", required: true, loopback: true });
  });

  it("returns 401 for every /stack/v1 path without a session", async () => {
    expect(v1Paths.length).toBeGreaterThanOrEqual(50);
    let answered = 0;
    for (const path of v1Paths) {
      const { status, body } = await request(path);
      if (status === 404) continue;
      answered += 1;
      expect(status, `expected 401 for ${path}`).toBe(401);
      expect(body, `expected error for ${path}`).toEqual({ error: "Operator authentication required" });
    }
    expect(answered).toBeGreaterThanOrEqual(30);
  });

  it("returns 401 after logout until login again", async () => {
    __resetOperatorForTests();
    const sessionResp = await app.request("/stack/v1/operator/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "op-pass" }),
    });
    const setCookie = sessionResp.headers.get("set-cookie") ?? "";
    const sessionCookie = setCookie.split(";")[0]!;
    expect(sessionCookie).toMatch(/^stack_session=/);

    const loggedInState = await request("/stack/v1/operator", { headers: { cookie: sessionCookie } });
    expect(loggedInState.body).toMatchObject({ state: "signedIn" });

    const modelsWithSession = await request("/stack/v1/models", { headers: { cookie: sessionCookie } });
    expect(modelsWithSession.status).toBe(200);

    const logout = await request("/stack/v1/operator/logout", { method: "POST", headers: { cookie: sessionCookie } });
    expect(logout.status).toBe(200);
    expect(logout.body).toEqual({ state: "signedOut", required: true, loopback: true });

    const afterLogout = await request("/stack/v1/models", { headers: { cookie: sessionCookie } });
    expect(afterLogout.status).toBe(401);
    expect(afterLogout.body).toEqual({ error: "Operator authentication required" });

    const reloginResp = await app.request("/stack/v1/operator/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "op-pass" }),
    });
    const newCookie = (reloginResp.headers.get("set-cookie") ?? "").split(";")[0]!;
    const modelsAgain = await request("/stack/v1/models", { headers: { cookie: newCookie } });
    expect(modelsAgain.status).toBe(200);
  });

  it("answers /v1/models with a client key", async () => {
    const key = issueClient("session-test-client", [...ROLE_IDS]);
    try {
      expect(resolveClient(key)).toBeTruthy();
      const { status } = await request("/stack/v1/models", { headers: { authorization: `Bearer ${key}` } });
      expect(status).toBe(200);
    } finally {
      const row = resolveClient(key);
      if (row) {
        const { db } = await import("@/db");
        const { clients } = await import("@/db/schema");
        const { eq } = await import("drizzle-orm");
        db.update(clients).set({ revokedAt: new Date().toISOString() }).where(eq(clients.id, row.id)).run();
      }
    }
  });

  it("refuses LAN requests without an operator", async () => {
    const lanBase = "http://192.168.1.50:4000";
    expect(lanPaths.length).toBeGreaterThanOrEqual(1);
    for (const path of lanPaths) {
      const { status } = await request(path, undefined, lanBase);
      expect(status, `expected 401 for ${path} from LAN`).toBe(401);
    }
  });
});
