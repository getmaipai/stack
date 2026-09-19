import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/app";
import { engineStorageTag } from "@/routes/engines";
import { __resetOperatorForTests, __resetOperatorThrottleForTests } from "@/lib/operator";
import { engineTagRoot } from "@/lib/store/layout";

let dataDir: string | null = null;
beforeEach(() => { __resetOperatorForTests(); __resetOperatorThrottleForTests(); });
afterEach(() => { __resetOperatorForTests(); __resetOperatorThrottleForTests(); if (dataDir) rmSync(dataDir, { recursive: true, force: true }); dataDir = null; delete process.env.STACK_SCRIPTED_ENGINES; delete process.env.STACK_MANAGED_ENGINE_URL; });

async function operatorCookie(): Promise<string> {
  const response = await app.request("/stack/v1/operator/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test password" }) });
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

test("operator engine controls start, stop, restart, probe, swap, and protect current removal", async () => {
  dataDir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "maipai-engines-route-")); process.env.STACK_DATA_DIR = dataDir; process.env.STACK_SCRIPTED_ENGINES = "1";
  const cookie = await operatorCookie(); const headers = { cookie, "content-type": "application/json" };
  for (const action of ["start", "stop", "restart"]) {
    const response = await app.request(`/stack/v1/engines/llama-server/${action}`, { method: "POST", headers });
    expect(response.status).toBe(200);
  }
  const probe = Bun.serve({ port: 0, fetch: (request) => new URL(request.url).pathname === "/health" ? Response.json({ status: "ok" }) : Response.json({ build_info: "b-test" }) });
  try {
    process.env.STACK_MANAGED_ENGINE_URL = String(probe.url).replace(/\/$/, "");
    const response = await app.request("/stack/v1/engines/managed/probe", { method: "POST", headers });
    expect(response.status).toBe(200); expect((await response.json() as { healthy: boolean }).healthy).toBe(true);
  } finally { probe.stop(true); }
  mkdirSync(engineTagRoot("llama-server", "b-test"), { recursive: true });
  const current = await app.request("/stack/v1/engines/llama-server/current", { method: "POST", headers, body: JSON.stringify({ tag: "b-test" }) });
  expect(current.status).toBe(200);
  const remove = await app.request("/stack/v1/engines/llama-server/builds/b-test", { method: "DELETE", headers });
  expect(remove.status).toBe(400); expect((await remove.json() as { error: string }).error).toContain("current");
  const invalidInstall = await app.request("/stack/v1/engines/llama-server/install", { method: "POST", headers, body: JSON.stringify({ tag: "b-nope" }) });
  expect(invalidInstall.status).toBe(400);
});

test("an externally managed engine refuses its stop with 409", async () => {
  dataDir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "maipai-engines-route-")); process.env.STACK_DATA_DIR = dataDir;
  const cookie = await operatorCookie(); const headers = { cookie, "content-type": "application/json" };
  const calls: string[] = [];
  const host = Bun.serve({ port: 0, fetch: (request) => { calls.push(new URL(request.url).pathname); return Response.json({ status: "ok" }); } });
  try {
    process.env.STACK_MANAGED_ENGINE_URL = String(host.url).replace(/\/$/, "");
    const response = await app.request(`/stack/v1/engines/llama-server/stop`, { method: "POST", headers });
    expect(response.status).toBe(409); expect((await response.json() as { error: string }).error).toBe("Managed outside the Stack.");
    expect(calls).toEqual([]);
  } finally { host.stop(true); }
});

test("an unknown engine name is a 404, not an external-management 409", async () => {
  dataDir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "maipai-engines-route-")); process.env.STACK_DATA_DIR = dataDir;
  const cookie = await operatorCookie(); const headers = { cookie, "content-type": "application/json" };
  for (const action of ["start", "stop", "restart"] as const) {
    const response = await app.request(`/stack/v1/engines/nope/${action}`, { method: "POST", headers });
    expect(response.status).toBe(404); expect((await response.json() as { error: string }).error).toBe("Unknown engine.");
  }
});

test("the engine API maps a visible catalog build tag to its platform-specific store tag", () => {
  expect(engineStorageTag("llama-server", "b10797")).toBe("b10797-macos-arm64");
});
