// Restart the Stack, restart the computer (off by default), engine restart
// 404, and the redacted log, through the real guard on a loopback server.
// The executors are fakes: nothing here restarts anything.
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveOptions } from "@/daemon";
import { __resetAdultViewForTests } from "@/lib/adultView";
import { __resetAdminAuthRateLimitsForTests, resetAdmin } from "@/lib/adminAuth";
import { readLogTail, redactLogLine, setAdminExecutorsForTests } from "@/lib/adminActions";
import { dataDir } from "@/lib/paths";
import { logger } from "@/lib/log";
import { __resetSettingsForTests, updateSettings } from "@/settings";

const TOKEN = "t".repeat(40);
const PASSWORD = "correct horse battery";
let server: ReturnType<typeof Bun.serve>;
let base = "";
const previous = process.env.STACK_HOME_VIEW_TOKEN;
const calls = { restart: 0, reboot: 0 };
let installed = true;
let lines: string[] = [];
let spy: ReturnType<typeof spyOn>;

beforeAll(() => {
  process.env.STACK_HOME_VIEW_TOKEN = TOKEN;
  __resetAdultViewForTests();
  server = Bun.serve({ ...serveOptions(), port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => {
  server.stop(true);
  await resetAdmin(dataDir);
  if (previous === undefined) delete process.env.STACK_HOME_VIEW_TOKEN; else process.env.STACK_HOME_VIEW_TOKEN = previous;
  __resetAdultViewForTests();
});
beforeEach(() => {
  __resetAdminAuthRateLimitsForTests();
  calls.restart = 0; calls.reboot = 0; installed = true; lines = [];
  setAdminExecutorsForTests({ serviceInstalled: () => installed, restartService: () => { calls.restart++; }, rebootHost: () => { calls.reboot++; } });
  spy = spyOn(logger, "appendLine").mockImplementation((line: string) => { lines.push(line); });
});
afterEach(() => { spy.mockRestore(); setAdminExecutorsForTests(null); __resetSettingsForTests(); });

const home = { "x-maipai-home-token": TOKEN, "content-type": "application/json" };
async function adminHeaders(): Promise<Record<string, string>> {
  const code = await resetAdmin(dataDir);
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await post("/stack/v1/admin/setup", { code, password: PASSWORD })).status).toBe(200);
  const res = await post("/stack/v1/admin/login", { password: PASSWORD });
  const token = /stack_admin=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]!;
  return { cookie: `stack_admin=${token}`, "x-stack-admin": "1", origin: base, "content-type": "application/json" };
}
const wait = () => new Promise((resolve) => setTimeout(resolve, 1100));
const events = () => lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, string>);

test("service restart: unguarded callers are refused, Home and an admin session are accepted and logged with source, then the executor runs once", async () => {
  expect((await fetch(`${base}/stack/v1/service/restart`, { method: "POST" })).status).toBe(401);
  expect((await fetch(`${base}/stack/v1/service/restart`, { method: "POST", headers: { "content-type": "application/json", "x-stack-admin": "1", cookie: "stack_admin=bogus", origin: base } })).status).toBe(401);
  const viaHome = await fetch(`${base}/stack/v1/service/restart`, { method: "POST", headers: home });
  expect(viaHome.status).toBe(202);
  expect(((await viaHome.json()) as { source: string }).source).toBe("home");
  const admin = await adminHeaders();
  expect((await fetch(`${base}/stack/v1/service/restart`, { method: "POST", headers: { ...admin, "x-stack-admin": "" } })).status).toBe(403);
  const viaAdmin = await fetch(`${base}/stack/v1/service/restart`, { method: "POST", headers: admin });
  expect(viaAdmin.status).toBe(202);
  expect(((await viaAdmin.json()) as { source: string }).source).toBe("admin");
  expect(calls.restart).toBe(0);
  await wait();
  expect(calls.restart).toBe(2);
  const logged = events().filter((e) => e.event === "admin.action.service.restart");
  expect(logged.map((e) => e.source)).toEqual(["home", "admin"]);
  expect(logged[0]!.at).toMatch(/^\d{4}-/);
});

test("service restart: a Stack not run by a unit gets a 409 sentence and nothing restarts", async () => {
  installed = false;
  const res = await fetch(`${base}/stack/v1/service/restart`, { method: "POST", headers: home });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { code: string }).code).toBe("service_not_installed");
  await wait();
  expect(calls.restart).toBe(0);
});

test("host reboot is refused while the setting is off (the default), and runs the executor once when on", async () => {
  const off = await fetch(`${base}/stack/v1/host/reboot`, { method: "POST", headers: home });
  expect(off.status).toBe(403);
  const data = await off.json() as { code: string; error: string };
  expect(data.code).toBe("reboot_disabled");
  expect(data.error).toContain("switched off");
  expect(events().some((e) => e.event === "admin.action.host.reboot.refused" && e.source === "home")).toBe(true);
  await wait();
  expect(calls.reboot).toBe(0);
  updateSettings({ "stack.admin.allow_reboot": true });
  const on = await fetch(`${base}/stack/v1/host/reboot`, { method: "POST", headers: await adminHeaders() });
  expect(on.status).toBe(202);
  expect(calls.reboot).toBe(0);
  await wait();
  expect(calls.reboot).toBe(1);
  expect(events().some((e) => e.event === "admin.action.host.reboot" && e.source === "admin")).toBe(true);
});

test("engine restart: an unknown name is 404 and runs nothing", async () => {
  const res = await fetch(`${base}/stack/v1/engines/no-such-engine/restart`, { method: "POST", headers: home });
  expect(res.status).toBe(404);
  expect(events().some((e) => e.event === "admin.action.engine.restart")).toBe(false);
});

test("redaction strips tokens, cookies, keys, session ids and setup codes but keeps the rest", () => {
  const secret = ["a1b2c3d4", "e5f60718", "293a4b5c", "6d7e8f90", "12345678"].join("");
  const bearer = ["abcdef12", "34567890XYZ"].join("");
  const sk = ["sk", "abcdefghijklmnop1234"].join("-");
  const code = ["ABCDEFGHIJKLMNOP", "QRSTUVWXYZ234567"].join("");
  const dirty = [
    `GET /x authorization: Bearer ${bearer}`,
    `cookie: stack_admin=${secret}; other=1`,
    `{"event":"x","token":"${secret}","api_key":"${sk}"}`,
    `x-maipai-home-token: ${secret}`,
    `LLAMA_API_KEY=${secret} started`,
    `admin setup_code: ${code}`,
    `engine chat ready in 3.2s`,
  ].map(redactLogLine).join("\n");
  for (const bad of [secret, bearer, sk, code]) expect(dirty).not.toContain(bad);
  expect(dirty).toContain("engine chat ready in 3.2s");
  expect(dirty).toContain("[redacted]");
});

test("GET /logs returns the last lines redacted, validates tail, and readLogTail honours the count", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "stack-log-")), "stack.log");
  writeFileSync(file, Array.from({ length: 50 }, (_, i) => `line ${i} token=${"z".repeat(30)}`).join("\n") + "\n");
  const tail = readLogTail(5, file);
  expect(tail).toHaveLength(5);
  expect(tail[4]).toStartWith("line 49 ");
  expect(tail.join("")).not.toContain("zzzz");
  expect((await fetch(`${base}/stack/v1/logs?tail=0`, { headers: home })).status).toBe(400);
  expect((await fetch(`${base}/stack/v1/logs?tail=99999`, { headers: home })).status).toBe(400);
  const res = await fetch(`${base}/stack/v1/logs?tail=3`, { headers: home });
  expect(res.status).toBe(200);
  const body = await res.json() as { lines: string[]; redacted: boolean };
  expect(body.redacted).toBe(true);
  expect(body.lines.length).toBeLessThanOrEqual(3);
});
