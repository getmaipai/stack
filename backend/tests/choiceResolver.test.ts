// What runs (docs/dev/choices.md, "What runs"): a stored choice is the model that answers. Small fake engines stand in for the models, as the
// supervisor tests do; no model is loaded for real.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { StackPartView } from "@maipai/spec/stack/ts/stack-part-view.js";
import { app } from "@/app";
import { __setChoicesDepsForTests } from "@/lib/choices";
import { __resetChoicesForTests, withPick, writePicks, readPicks } from "@/lib/choicesStore";
import { __resetPartChoicesForTests, writePartChoices } from "@/lib/partChoices";
import { clearModelsForTests, upsertModel } from "@/lib/modelStore";
import { __resetSettingsForTests, settingIntent, updateSettings } from "@/settings";
import { decide, liveEnv } from "@/lib/choiceResolver";
import { unnamedJobModel } from "@/lib/choiceRuntime";
import { getProcess, loadedModelId, resetSupervisorForTests, scriptedProcess, selectedModel, setMachineTier, setSupervisorFactoryForTests } from "@/lib/supervisor";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly } from "@/lib/governor";
import { __resetHealthForTests } from "@/lib/health";
import { __setProfileDepsForTests } from "@/routes/profiles";
import type { HardwareInfo } from "@/lib/hardware";
import type { CategoryId } from "@/lib/choicesSchema";

const GIB = 1_073_741_824;
const hw = (gb: number): HardwareInfo => ({ platform: "darwin", arch: "arm64", totalRamGb: gb, cpuCount: 8, isAppleSilicon: true, unifiedMemoryGb: gb, cudaDevices: [], freeDiskBytes: 1e12, osVersion: "test" });
const EIGHT = "qwen3-8b-instruct-q4-k-m";
const HUIHUI = "qwen3-6-35b-a3b-huihui-abliterated-q4-k-m";
let installedParts = new Set<string>();
let loadFails = new Set<string>();
let startedWith: string[] = [];

function install(id: string, roles: Array<"chat" | "stt" | "vision" | "embed">): void {
  upsertModel({ id, roles, source: "catalog", provenance: {}, revision: "r1", sha256: "a".repeat(64), licence: "Apache-2.0", verifiedAt: new Date().toISOString(), modelPath: `/tmp/never-opened/${id}.gguf`, sizeBytes: 5_000_000_000 });
  installedParts.add(id);
}

beforeEach(() => {
  installedParts = new Set(); loadFails = new Set(); startedWith = [];
  __resetHealthForTests(); __resetGovernorForTests(); __resetSettingsForTests(); __resetChoicesForTests(); __resetPartChoicesForTests(); clearModelsForTests();
  setMachineTier("p128");
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GIB, freeMemoryBytes: 110 * GIB, tier: "p128" });
  setSupervisorFactoryForTests(async (role, modelId) => {
    const model = modelId ?? selectedModel(role)?.id ?? role;
    if (loadFails.has(model)) throw new Error(`${model} would not start.`);
    startedWith.push(`${role}:${model}`);
    return scriptedProcess(role, { modelId: model });
  });
  __setChoicesDepsForTests({
    probe: async () => hw(128),
    installPart: async (id) => ({ job: `job-${id}` }),
    parts: async (hardware) => {
      const { listParts } = await import("@/lib/partsList");
      return (await listParts({ audience: "adult" }, hardware)).parts.map((part): StackPartView => installedParts.has(part.id) ? { ...part, state: "ready", size_bytes: 5_000_000_000, download_bytes: 0, can_uninstall: true, uninstall_block: null, required_by: [] } : part);
    },
  });
  __setProfileDepsForTests({ probe: async () => hw(128), install: async (pin) => ({ job: `job-${pin.id}`, done: Promise.resolve() }) });
});
afterEach(() => {
  __setChoicesDepsForTests(null); __setProfileDepsForTests(null); setSupervisorFactoryForTests(null); resetSupervisorForTests(); setMachineTier(null);
  __resetSettingsForTests(); __resetChoicesForTests(); __resetPartChoicesForTests(); clearModelsForTests(); __resetGovernorForTests();
});

const choices = (method: string, path: string, body?: unknown) => app.request(`/stack/v1/choices${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
type Running = { active: boolean; model: string | null; answering: boolean; reason: string | null };
type Row = { tier: string; chosen: string | null; chosen_by: string; running: Running };
type RoleChoice = { category: string; level: string; chosen: string | null; chosen_by: string; model: string | null; answering: boolean; reason: string | null };
const readChoices = async () => (await (await choices("GET", "")).json()) as { categories: Array<{ id: CategoryId; role: string | null; tiers: Row[] }> };
const readRoles = async () => ((await (await app.request("/stack/v1/roles")).json()) as { roles: Array<{ id: string; choice: RoleChoice | null }> }).roles;

test("a stored pick changes the model chat resolves to, and nothing else moves until it is picked", () => {
  install(EIGHT, ["chat"]); install(HUIHUI, ["chat"]);
  expect(selectedModel("chat")?.id).toBe(EIGHT);
  writePicks(withPick({}, "p128", "chat", "standard", { model: HUIHUI }));
  expect(selectedModel("chat")?.id).toBe(HUIHUI);
  expect(selectedModel("judge")?.id).not.toBe(HUIHUI);
  writePicks({});
  expect(selectedModel("chat")?.id).toBe(EIGHT);
});

test("a pick that is not installed leaves the previous model serving and says why through the role and the choices read", async () => {
  install(EIGHT, ["chat"]);
  const running = await getProcess("chat");
  expect(running.modelId).toBe(EIGHT);
  const picked = await choices("PUT", "/chat/standard", { model: HUIHUI, install: false });
  expect(picked.status).toBe(200);
  expect(await picked.json()).toMatchObject({ applied: false, note: expect.stringContaining("keeps answering") });
  expect(selectedModel("chat")?.id).toBe(EIGHT);
  expect(loadedModelId("chat")).toBe(EIGHT);
  const role = (await readRoles()).find((item) => item.id === "chat")!.choice!;
  expect(role).toMatchObject({ category: "chat", level: "standard", chosen: HUIHUI, chosen_by: "household", model: EIGHT, answering: false });
  expect(role.reason).toContain("not installed yet");
  expect(role.reason).toContain("keeps answering");
  const row = (await readChoices()).categories.find((item) => item.id === "chat")!.tiers.find((item) => item.tier === "standard")!;
  expect(row.running).toMatchObject({ active: true, model: EIGHT, answering: false });
  // Installing it is all that is missing: the next start (and a pick made now) uses it.
  install(HUIHUI, ["chat"]);
  expect(selectedModel("chat")?.id).toBe(HUIHUI);
});

test("a pick made with the model installed swaps the running chat engine without a restart of the Stack, and the role says it is answering", async () => {
  install(EIGHT, ["chat"]); install(HUIHUI, ["chat"]);
  await getProcess("chat");
  const picked = await choices("PUT", "/chat/standard", { model: HUIHUI });
  expect(await picked.json()).toMatchObject({ ok: true, applied: true, pending_restart: false });
  expect(startedWith.at(-1)).toBe(`chat:${HUIHUI}`);
  expect(loadedModelId("chat")).toBe(HUIHUI);
  expect(selectedModel("chat")?.id).toBe(HUIHUI);
  expect((await readRoles()).find((item) => item.id === "chat")!.choice).toMatchObject({ chosen: HUIHUI, model: HUIHUI, answering: true, reason: null });
});

test("a swap that will not start keeps the earlier model answering and says so", async () => {
  install(EIGHT, ["chat"]); install(HUIHUI, ["chat"]);
  await getProcess("chat");
  loadFails.add(HUIHUI);
  const picked = await (await choices("PUT", "/chat/standard", { model: HUIHUI })).json() as { applied: boolean; note: string | null };
  expect(picked.applied).toBe(false);
  expect(picked.note).toContain("keeps answering");
  expect(loadedModelId("chat")).toBe(EIGHT);
  const role = (await readRoles()).find((item) => item.id === "chat")!.choice!;
  expect(role).toMatchObject({ model: EIGHT, chosen: HUIHUI, answering: false });
});

test("the order puts a model first and the off list keeps one from running", () => {
  install(EIGHT, ["chat"]); install(HUIHUI, ["chat"]);
  writePartChoices({ chat: { order: [HUIHUI], off: [] } });
  expect(selectedModel("chat")?.id).toBe(HUIHUI);
  writePartChoices({ chat: { order: [HUIHUI], off: [HUIHUI] } });
  expect(selectedModel("chat")?.id).toBe(EIGHT);
  writePartChoices({ chat: { order: [], off: [EIGHT] } });
  expect(selectedModel("chat")?.id).toBe(HUIHUI);
  // A household pick that is switched off does not run, and the page says why.
  writePartChoices({ chat: { order: [], off: [HUIHUI] } });
  writePicks(withPick({}, "p128", "chat", "standard", { model: HUIHUI }));
  expect(selectedModel("chat")?.id).toBe(EIGHT);
  expect(decide(liveEnv()!, "chat", "standard")).toMatchObject({ model: EIGHT, problem: expect.stringContaining("switched off") });
});

test("Home's older push, the chat model setting, and the pick are one value in both directions", async () => {
  install(EIGHT, ["chat"]); install(HUIHUI, ["chat"]);
  updateSettings({ "stack.engines.chat.model": HUIHUI });
  expect(readPicks().p128?.chat?.standard).toEqual({ model: HUIHUI });
  expect(selectedModel("chat")?.id).toBe(HUIHUI);
  // A pick made on the page writes the setting the older Home reads.
  await choices("PUT", "/chat/standard", { model: EIGHT });
  expect(settingIntent("stack.engines.chat.model")).toBe(EIGHT);
  expect(selectedModel("chat")?.id).toBe(EIGHT);
  // Back to the recommended model clears both, so neither keeps the old model running.
  updateSettings({ "stack.engines.chat.model": HUIHUI });
  await choices("PUT", "/chat/standard", { model: "recommended" });
  expect(readPicks().p128?.chat?.standard).toBeUndefined();
  expect(settingIntent("stack.engines.chat.model")).toBe("");
  expect(selectedModel("chat")?.id).toBe(EIGHT);
  // The older Home writing "the recommended model" (an empty value) clears a pick too.
  await choices("PUT", "/chat/standard", { model: HUIHUI });
  updateSettings({ "stack.engines.chat.model": "" });
  expect(readPicks().p128?.chat?.standard).toBeUndefined();
});

test("the voice engine follows the stored pick without a restart of the Stack, and the voice setting and the pick agree", async () => {
  expect(settingIntent("stack.voice.engine")).toBe("auto");
  const picked = await choices("PUT", "/voice/standard", { model: "voxcpm2-bf16", install: false });
  expect(picked.status).toBe(200);
  expect(settingIntent("stack.voice.engine")).toBe("voxcpm2");
  const { activeTtsChoice } = await import("@/lib/supervisor");
  expect(activeTtsChoice().requested).toBe("voxcpm2");
  updateSettings({ "stack.voice.engine": "pocket" });
  expect(readPicks().p128?.voice?.standard).toEqual({ model: "pocket-tts-english" });
  expect(activeTtsChoice().requested).toBe("pocket");
});

test("Max chat refuses a model coding mode cannot start, instead of saving a choice that changes nothing", async () => {
  const refused = await choices("PUT", "/chat/max", { model: EIGHT, install: false });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ code: "not_runnable_at_level", error: expect.stringContaining("Flash Next") });
});

test("a level switched off runs nothing: a picture or clip asked for without a model is told so, and a pick that is not installed leaves the old default", async () => {
  writePicks(withPick({}, "p128", "pictures", "boost", { model: "off" }));
  expect(unnamedJobModel("pictures", "boost").levelOff).toContain("switched off");
  const res = await app.request("/v1/images/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "a red kite", tier: "boost" }) });
  expect([409, 503]).toContain(res.status);
  if (res.status === 409) expect(JSON.stringify(await res.json())).toContain("level_off");
  // A chosen model that is not on this computer is not used: the caller keeps the model that ran before.
  writePicks(withPick({}, "p128", "pictures", "standard", { model: "ernie-image-turbo" }));
  expect(unnamedJobModel("pictures", "standard")).toEqual({ model: null, levelOff: null });
});

test("the role view and the choices read agree for every category, with and without picks", async () => {
  install(EIGHT, ["chat"]); install(HUIHUI, ["chat"]);
  await getProcess("chat");
  const compare = async () => {
    const view = await readChoices();
    const roles = await readRoles();
    let compared = 0;
    for (const category of view.categories) {
      if (!category.role) continue;
      const role = roles.find((item) => item.id === category.role)!;
      expect(role.choice, category.id).not.toBeNull();
      const row = category.tiers.find((item) => item.tier === role.choice!.level)!;
      expect(row, `${category.id} has a ${role.choice!.level} row`).toBeDefined();
      expect({ chosen: row.chosen, by: row.chosen_by }, `${category.id} chosen`).toEqual({ chosen: role.choice!.chosen, by: role.choice!.chosen_by });
      expect(row.running.answering, `${category.id} answering`).toBe(role.choice!.answering);
      expect(row.running.model, `${category.id} model`).toBe(role.choice!.model);
      expect(row.running.reason ?? null, `${category.id} reason`).toBe(role.choice!.reason ?? null);
      compared += 1;
    }
    expect(compared).toBeGreaterThanOrEqual(9);
  };
  await compare();
  await choices("PUT", "/chat/standard", { model: HUIHUI });
  await choices("PUT", "/voice/standard", { model: "voxcpm2-bf16", install: false });
  await choices("PUT", "/stt/standard", { model: "moonshine-tiny-en-int8", install: false });
  await compare();
});
