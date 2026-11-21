// ADMIN-05: POST /stack/v1/profiles/recommend and /apply. The hardware probe and the install starter are injected; settings, the audit
// log and the saved choice are the real ones.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { app } from "@/app";
import { logger } from "@/lib/log";
import { __resetSettingsForTests, settingValues } from "@/settings";
import { __setProfileDepsForTests } from "@/routes/profiles";
import { isRoleDisabled, rolePriorityOf } from "@/lib/roleSwitches";
import type { HardwareInfo } from "@/lib/hardware";

const hw = (gb: number): HardwareInfo => ({ platform: "darwin", arch: "arm64", totalRamGb: gb, cpuCount: 8, isAppleSilicon: true, unifiedMemoryGb: gb, cudaDevices: [], freeDiskBytes: 1e12, osVersion: "test" });
let memory = 48;
let installed: string[] = [];
let lines: string[] = [];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  memory = 48; installed = []; lines = [];
  __resetSettingsForTests();
  __setProfileDepsForTests({ probe: async () => hw(memory), install: async (pin) => { installed.push(pin.id); return { job: `job-${pin.id}`, done: Promise.resolve() }; } });
  spy = spyOn(logger, "appendLine").mockImplementation((line: string) => { lines.push(line); });
});
afterEach(() => { spy.mockRestore(); __setProfileDepsForTests(null); __resetSettingsForTests(); });

const post = (path: string, body?: unknown) => app.request(`/stack/v1/profiles/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const audit = () => lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, string>);

test("recommend answers matched, custom recommended and the templates for a 48 GB computer", async () => {
  const res = await post("recommend", {});
  expect(res.status).toBe(200);
  const body = await res.json() as { memory: { gb: number }; matched: unknown; custom_recommended: { plan: { tier: string; roles: Array<{ role: string }> }; why: string[] }; templates: unknown[]; saved: unknown; replan: { needed: boolean } };
  expect(body.memory.gb).toBe(48);
  expect(body.matched).toBeNull();
  expect(body.custom_recommended.plan.tier).toBe("p32");
  expect(body.custom_recommended.why.length).toBeGreaterThan(2);
  expect(body.templates).toHaveLength(4);
  expect(body.saved).toBeNull();
  expect(body.replan.needed).toBe(false);
});

test("recommend writes nothing and reads the stored role switches; a body override is for that question only", async () => {
  const before = settingValues();
  const body = await (await post("recommend", { roles: [{ role: "music", enabled: false }, { role: "image", priority: 5 }] })).json() as { custom_recommended: { plan: { roles: Array<{ role: string; state: string; priority: number }> } } };
  expect(body.custom_recommended.plan.roles.find((r) => r.role === "music")!.state).toBe("off");
  expect(body.custom_recommended.plan.roles[0]!.role).toBe("image");
  expect(settingValues()).toEqual(before);
  expect(isRoleDisabled("music")).toBe(false);
});

test("apply custom_recommended writes the role settings, saves the mode and audits it", async () => {
  const res = await post("apply", { mode: "custom_recommended" });
  expect(res.status).toBe(200);
  const body = await res.json() as { tier: string; settings: Record<string, unknown> };
  expect(body.tier).toBe("p32");
  expect(body.settings["stack.roles.music.enabled"]).toBe(true);
  expect(body.settings["stack.engines.chat.model"]).toBe("");
  expect(audit().some((e) => e.event === "admin.action.profile.apply" && e.mode === "custom_recommended" && e.source === "home")).toBe(true);
  const saved = (await (await post("recommend", {})).json() as { saved: { mode: string; memory_gb: number } }).saved;
  expect(saved).toMatchObject({ mode: "custom_recommended", memory_gb: 48 });
  // starts the tier's pinned installs as ordinary jobs, the starter chat among them
  expect(installed).toContain("qwen3-8b-instruct-q4-k-m");
});

test("apply matched uses the tier's template and resets priority; a tier above this computer is refused", async () => {
  memory = 32;
  const ok = await post("apply", { mode: "matched" });
  expect(ok.status).toBe(200);
  expect((await ok.json() as { tier: string }).tier).toBe("p32");
  expect(rolePriorityOf("chat")).toBe(100);
  const refused = await post("apply", { mode: "matched", tier: "p64" });
  expect(refused.status).toBe(409);
  expect((await refused.json() as { error: string }).error).toContain("needs more memory");
});

test("apply custom writes exactly the chosen roles, installs nothing, and judges them with the fit check", async () => {
  memory = 32;
  const res = await post("apply", { mode: "custom", plan: { roles: [{ role: "music", enabled: false }, { role: "tts", priority: 7 }] } });
  expect(res.status).toBe(200);
  const body = await res.json() as { settings: Record<string, unknown>; installs: unknown[]; plan: { roles: Array<{ role: string; state: string }> } };
  expect(body.settings).toEqual({ "stack.roles.music.enabled": false, "stack.roles.tts.priority": 7 });
  expect(body.installs).toEqual([]);
  expect(installed).toEqual([]);
  expect(isRoleDisabled("music")).toBe(true);
  expect(rolePriorityOf("tts")).toBe(7);
  expect(body.plan.roles.find((r) => r.role === "music")!.state).toBe("off");
});

test("apply custom without roles is a plain 400; an out of range priority is refused by the schema", async () => {
  expect((await post("apply", { mode: "custom" })).status).toBe(400);
  expect((await post("apply", { mode: "custom", plan: { roles: [{ role: "tts", priority: 0 }] } })).status).toBe(400);
});

test("a computer below 16 GB: apply answers 409 and changes nothing", async () => {
  memory = 8;
  const res = await post("apply", { mode: "custom_recommended" });
  expect(res.status).toBe(409);
  expect((await res.json() as { error: string }).error).toContain("Nothing was changed");
  expect(audit().some((e) => e.event === "admin.action.profile.apply")).toBe(false);
});

test("a disk refusal on an install is listed as skipped with its reason, the rest still apply", async () => {
  const { DiskRefusalError } = await import("@/lib/diskState");
  __setProfileDepsForTests({ probe: async () => hw(48), install: async (pin) => { if (pin.id === "qwen3-8b-instruct-q4-k-m") throw new DiskRefusalError("Not enough free disk space."); installed.push(pin.id); return { job: `job-${pin.id}`, done: Promise.resolve() }; } });
  const body = await (await post("apply", { mode: "matched", tier: "p32" })).json() as { skipped: Array<{ model: string; reason: string }> };
  expect(body.skipped).toContainEqual({ model: "qwen3-8b-instruct-q4-k-m", reason: "Not enough free disk space." });
  expect(installed.length).toBeGreaterThan(0);
});

test("a saved matched or recommended choice asks to re-plan when the memory changes; custom never does", async () => {
  await post("apply", { mode: "custom_recommended" });
  memory = 64;
  const changed = await (await post("recommend", {})).json() as { replan: { needed: boolean; reason: string } };
  expect(changed.replan.needed).toBe(true);
  expect(changed.replan.reason).toContain("48 GB");
  await post("apply", { mode: "custom", plan: { roles: [{ role: "tts", priority: 9 }] } });
  memory = 96;
  expect(((await (await post("recommend", {})).json()) as { replan: { needed: boolean } }).replan.needed).toBe(false);
});
