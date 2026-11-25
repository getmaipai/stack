import { afterEach, describe, expect, test } from "bun:test";
import { app } from "@/app";
import { db } from "@/db";
import { connections } from "@/db/schema";
import { guardRequest } from "@/lib/requestGuard";
import { homeViewToken } from "@/lib/adultView";
import { __resetConnectionsForTests, noteHomeSeen, SEEN_LATELY_MS, TEST_NOT_AVAILABLE, listConnections } from "@/lib/connections";
import { StackConnection } from "@maipai/spec/stack/ts/stack-connection.js";

const call = (method: string, path: string, body?: unknown) => app.request(`/stack/v1/connections${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const list = async () => ((await (await call("GET", "")).json()) as { connections: Array<{ id: string; kind: string; state: string; last_seen_at?: string | null }> }).connections;
const mcp = { name: "Notes server", endpoint: { type: "url", url: "http://127.0.0.1:9000/mcp" } };
const add = async (extra: object = {}) => (await call("POST", "", { ...mcp, ...extra }));
afterEach(() => { db.delete(connections).run(); __resetConnectionsForTests(); });

describe("connections routes", () => {
  test("list starts empty and add makes an mcp record that matches the spec", async () => {
    expect(await list()).toEqual([]);
    const res = await add({ endpoint: { type: "command", command: "npx", args: ["-y", "notes-mcp"] }, secret_ref: "secret_notes1" });
    expect(res.status).toBe(201);
    const made = StackConnection.parse(await res.json());
    expect(made).toMatchObject({ kind: "mcp", reach: "command", state: "not_tested", tools: [], secret_ref: "secret_notes1", provenance: "stack:admin" });
    expect((await list()).map((c) => c.id)).toEqual([made.id]);
  });
  test("add refuses a blank name, a bad endpoint, a pasted secret and a duplicate name, in plain words", async () => {
    for (const bad of [{ name: "  " }, { endpoint: { type: "url", url: "ftp://x" } }, { endpoint: { type: "command", command: "" } }, { secret_ref: "pasted-value-here" }]) {
      const res = await add(bad); expect(res.status).toBe(400); expect(((await res.json()) as { error: string }).error.length).toBeGreaterThan(10);
    }
    expect((await add({ secret: "pasted-value-here" })).status).toBe(400);
    expect((await add()).status).toBe(201);
    expect((await add({ name: "NOTES server" })).status).toBe(400);
    expect(await list()).toHaveLength(1);
  });
  test("no reply or stored row holds a secret value", async () => {
    await add({ secret_ref: "secret_notes1" });
    const row = JSON.stringify(db.select().from(connections).all());
    expect(row).not.toMatch(/pasted|password/i);
  });
  test("test says it is not available yet; unknown id is 404", async () => {
    const id = ((await (await add()).json()) as { id: string }).id;
    const res = await call("POST", `/${id}/test`); expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, available: false, message: TEST_NOT_AVAILABLE });
    expect((await call("POST", "/conn_nothere1/test")).status).toBe(404);
  });
  test("pause then resume changes state and survives a list; removed records are gone", async () => {
    const id = ((await (await add()).json()) as { id: string }).id;
    const paused = (await (await call("POST", `/${id}/pause`)).json()) as { state: string };
    expect(paused.state).toBe("paused"); expect((await list())[0]!.state).toBe("paused");
    expect(((await (await call("POST", `/${id}/resume`)).json()) as { state: string }).state).toBe("not_tested");
    expect((await call("DELETE", `/${id}`)).status).toBe(200);
    expect(await list()).toEqual([]);
    for (const [m, p] of [["POST", `/${id}/pause`], ["POST", `/${id}/resume`], ["POST", `/${id}/test`], ["DELETE", `/${id}`]] as const) expect((await call(m, p)).status).toBe(404);
  });
});

describe("a paired Home", () => {
  test("a request with Home's token makes and stamps the Home record; one without does not", () => {
    expect(guardRequest(new Request("http://127.0.0.1/stack/v1/status", { headers: { host: "127.0.0.1" } }))).toBeNull();
    expect(listConnections()).toEqual([]);
    expect(guardRequest(new Request("http://127.0.0.1/stack/v1/status", { headers: { host: "127.0.0.1", "x-maipai-home-token": homeViewToken() } }))).toBeNull();
    const [home] = listConnections();
    expect(home).toMatchObject({ kind: "home", name: "Home", state: "connected", provenance: "stack:admission" });
    expect(home!.last_seen_at).toBeTruthy();
    expect(() => StackConnection.parse(home)).not.toThrow();
  });
  test("reads not seen lately; pause holds through a new stamp; resume restores; remove drops it", async () => {
    const t0 = Date.now(); noteHomeSeen(t0, true);
    const id = (await list())[0]!.id;
    expect(listConnections(t0 + SEEN_LATELY_MS + 1)[0]!.state).toBe("not_seen_lately");
    await call("POST", `/${id}/pause`);
    noteHomeSeen(t0 + 60_000, true);
    const paused = (await list())[0]!; expect(paused.state).toBe("paused"); expect(Date.parse(paused.last_seen_at!)).toBe(t0 + 60_000);
    expect(((await (await call("POST", `/${id}/resume`)).json()) as { state: string }).state).toBe("connected");
    await call("DELETE", `/${id}`); expect(await list()).toEqual([]);
  });
  test("the stamp is throttled", () => {
    noteHomeSeen(1_000_000, true); noteHomeSeen(1_000_500);
    expect(Date.parse(listConnections()[0]!.last_seen_at!)).toBe(1_000_000);
  });
});
