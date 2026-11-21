// ADMIN-04: a role can be turned off and has a priority, both declared
// settings. A turned-off role is not started, not admitted, and says why;
// priority orders the governor's waiting queue; a change through the
// settings route is audited like the other admin actions.
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { serveOptions } from "@/daemon";
import { __resetAdultViewForTests } from "@/lib/adultView";
import { __resetAdminAuthRateLimitsForTests, resetAdmin } from "@/lib/adminAuth";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit, getGovernorStatus } from "@/lib/governor";
import { dataDir } from "@/lib/paths";
import { logger } from "@/lib/log";
import { getProcess, resetSupervisorForTests, setSupervisorFactoryForTests, scriptedProcess } from "@/lib/supervisor";
import { __resetSettingsForTests, readSettings, updateSettings } from "@/settings";
import { defaultRolePriority, roleDisabledReason, rolePriorityOf } from "@/lib/roleSwitches";
import { ROLE_IDS } from "@/roles";

const GB = 1_073_741_824;
const TOKEN = "t".repeat(40);
const PASSWORD = "correct horse battery";
const home = { "x-maipai-home-token": TOKEN, "content-type": "application/json" };
let server: ReturnType<typeof Bun.serve>;
let base = "";
const previous = process.env.STACK_HOME_VIEW_TOKEN;
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
  __resetSettingsForTests();
  __resetGovernorForTests();
  lines = [];
  spy = spyOn(logger, "appendLine").mockImplementation((line: string) => { lines.push(line); });
});
afterEach(() => { spy.mockRestore(); __resetSettingsForTests(); __resetGovernorForTests(); resetSupervisorForTests(); setSupervisorFactoryForTests(null); });

async function adminHeaders(): Promise<Record<string, string>> {
  const code = await resetAdmin(dataDir);
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await post("/stack/v1/admin/setup", { code, password: PASSWORD })).status).toBe(200);
  const res = await post("/stack/v1/admin/login", { password: PASSWORD });
  const token = /stack_admin=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]!;
  return { cookie: `stack_admin=${token}`, "x-stack-admin": "1", origin: base, "content-type": "application/json" };
}

test("every role declares an enabled switch (on) and a priority in the Features section", () => {
  const settings = readSettings();
  for (const role of ROLE_IDS) {
    const on = settings.find((s) => s.key === `stack.roles.${role}.enabled`);
    const order = settings.find((s) => s.key === `stack.roles.${role}.priority`);
    expect(on).toMatchObject({ selector: "boolean", default: true, in_effect: true, section: { id: "roles" } });
    expect(order).toMatchObject({ selector: "number", default: defaultRolePriority(role), in_effect: defaultRolePriority(role) });
  }
  expect(() => updateSettings({ "stack.roles.chat.priority": 0 })).toThrow();
  expect(() => updateSettings({ "stack.roles.chat.enabled": "no" })).toThrow();
});

test("turning a role off takes effect at once and is read back from the one declaration", () => {
  expect(roleDisabledReason("image")).toBeNull();
  updateSettings({ "stack.roles.image.enabled": false, "stack.roles.music.priority": 5 });
  expect(roleDisabledReason("image")).toContain("Images is turned off");
  expect(rolePriorityOf("music")).toBe(5);
  updateSettings({ "stack.roles.image.enabled": true });
  expect(roleDisabledReason("image")).toBeNull();
});

test("a turned-off role is refused by the governor with its reason and a turned-on one is admitted", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 64 * GB, freeMemoryBytes: 32 * GB });
  updateSettings({ "stack.roles.image.enabled": false });
  const refused = await admit({ id: "picture", role: "image", kind: "generator", class: "warm", requestedBytes: GB });
  expect(refused).toMatchObject({ refused: true });
  expect((refused as { reason: string }).reason).toContain("Images is turned off");
  updateSettings({ "stack.roles.image.enabled": true });
  expect(await admit({ id: "picture", role: "image", kind: "generator", class: "warm", requestedBytes: GB })).toMatchObject({ id: "picture" });
});

test("a turned-off role is never launched", async () => {
  let launched = 0;
  setSupervisorFactoryForTests(async (role) => { launched++; return scriptedProcess(role); });
  updateSettings({ "stack.roles.embed.enabled": false });
  await expect(getProcess("embed")).rejects.toThrow("Embeddings is turned off");
  expect(launched).toBe(0);
  updateSettings({ "stack.roles.embed.enabled": true });
  await getProcess("embed");
  expect(launched).toBe(1);
});

test("priority orders the waiting queue: a higher-priority role that arrives later goes ahead", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 39 * GB, tier: "p128" });
  const order = async () => {
    __resetGovernorForTests();
    __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 39 * GB, tier: "p128" });
    expect(await admit({ id: "video", role: "video", kind: "generator", class: "burst", requestedBytes: 20 * GB })).toMatchObject({ queued: true });
    expect(await admit({ id: "music", role: "music", kind: "generator", class: "burst", requestedBytes: 20 * GB })).toMatchObject({ queued: true });
    return getGovernorStatus().queue.map((item) => item.id);
  };
  expect(await order()).toEqual(["video", "music"]);
  updateSettings({ "stack.roles.music.priority": 1 });
  expect(await order()).toEqual(["music", "video"]);
});

test("the roles route says enabled, priority and why a role is off", async () => {
  updateSettings({ "stack.roles.vision.enabled": false, "stack.roles.vision.priority": 7 });
  const body = await (await fetch(`${base}/stack/v1/roles`, { headers: home })).json() as { roles: Array<{ id: string; enabled: boolean; priority: number; state: { state: string; cause?: string }; reason: string | null; plain_reason: string | null }> };
  const vision = body.roles.find((r) => r.id === "vision")!;
  expect(vision).toMatchObject({ enabled: false, priority: 7, state: { state: "offline", cause: "disabled" } });
  expect(vision.reason).toContain("Vision is turned off");
  expect(vision.plain_reason).toContain("Vision is turned off");
  expect(body.roles.find((r) => r.id === "chat")).toMatchObject({ enabled: true, priority: 100 });
});

test("changing a role setting through the settings route is audited with source and what changed", async () => {
  const admin = await adminHeaders();
  const res = await fetch(`${base}/stack/v1/settings`, { method: "PUT", headers: admin, body: JSON.stringify({ "stack.roles.tts.enabled": false }) });
  expect(res.status).toBe(200);
  const viaHome = await fetch(`${base}/stack/v1/settings`, { method: "PUT", headers: home, body: JSON.stringify({ "stack.roles.tts.priority": 3 }) });
  expect(viaHome.status).toBe(200);
  const logged = lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, string>).filter((e) => e.event === "admin.action.roles.update");
  expect(logged.map((e) => e.source)).toEqual(["admin", "home"]);
  expect(logged[0]!.changes).toBe("stack.roles.tts.enabled=false");
  expect(logged[1]!.changes).toBe("stack.roles.tts.priority=3");
  // A setting outside the roles section writes no role audit line.
  await fetch(`${base}/stack/v1/settings`, { method: "PUT", headers: home, body: JSON.stringify({ "stack.runtime.keep_warm": false }) });
  expect(lines.filter((l) => l.includes("admin.action.roles.update"))).toHaveLength(2);
});
