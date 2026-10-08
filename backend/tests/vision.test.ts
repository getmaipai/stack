// VISION-01b: the `vision` role is its own model and process, chosen by
// the record's declared picture input (never a model id), launched with
// its projector at a short context, admitted by the governor as `jit`,
// and never a reason for chat to be evicted or shrunk.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { ModelCapabilities } from "@maipai/spec/gen/ts/model-capabilities.js";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit, getGovernorStatus, startGovernor, touch } from "@/lib/governor";
import { __resetHealthForTests } from "@/lib/health";
import { clearModelsForTests, registerCatalogModel, upsertModel, type CatalogModelLike } from "@/lib/modelStore";
import { STACK_MODELS, STACK_VISION_MODEL, STACK_VISION_PROJECTOR } from "@/lib/modelCatalog";
import { declaresImageInput, getProcess, getRoleStatus, probeRequest, processRoleFor, projectorFor, resetSupervisorForTests, restartRole, scriptedProcess, selectedModel, setSupervisorFactoryForTests, VISION_PROBE_IMAGE, withPinSampling } from "@/lib/supervisor";
import { pullSpec } from "@/routes/models";
import { app } from "@/app";
import { __resetSettingsForTests, applyPendingSettings, updateSettings } from "@/settings";
import type { RoleId } from "@/roles";

const GB = 1_073_741_824;
const verifiedAt = "2026-10-06T00:00:00.000Z";

function install(pin: CatalogModelLike, overrides: Partial<Parameters<typeof upsertModel>[0]> = {}) {
  const registered = registerCatalogModel(pin);
  return upsertModel({ ...registered, verifiedAt, modelPath: join("/tmp", `${pin.id}.gguf`), ...overrides });
}

let started: RoleId[] = [];
beforeEach(() => {
  started = [];
  clearModelsForTests();
  __resetSettingsForTests();
  __resetHealthForTests();
  __resetGovernorForTests();
  setSupervisorFactoryForTests(async (role) => { started.push(role); return scriptedProcess(role); });
});
afterEach(() => { setSupervisorFactoryForTests(null); resetSupervisorForTests(); clearModelsForTests(); __resetGovernorForTests(); });

test("the vision pins are Apache-2.0 at one Hub revision, the projector a component the model names", () => {
  expect(STACK_MODELS).toEqual(expect.arrayContaining([STACK_VISION_MODEL, STACK_VISION_PROJECTOR]));
  for (const pin of [STACK_VISION_MODEL, STACK_VISION_PROJECTOR]) {
    expect(pin.license).toBe("Apache-2.0");
    expect(pin.revision).toBe("1cd86afb9a95c410a6038ab3b40d8b578c892266");
    expect(pin.download!.url).toContain(`/resolve/${pin.revision}/`);
    expect(pin.download!.sha256).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(STACK_VISION_MODEL.download).toMatchObject({ sha256: "66358cb18bb6b3b1b6675aa412c7a88ef01d228f481184d13668e5201c730a0a", approx_bytes: 2_497_281_664 });
  expect(STACK_VISION_PROJECTOR.download).toMatchObject({ sha256: "30ba2c7dd3127a4561b6cba9d13d0f711c91bdb38742e2f56d73c8cb596bd06d", approx_bytes: 453_974_304 });
  expect(STACK_VISION_PROJECTOR.component).toBe("projector");
  expect(STACK_VISION_MODEL.imageInput).toEqual({ projector: STACK_VISION_PROJECTOR.id });
  expect(STACK_VISION_MODEL.sampling?.source).toContain("model card");
});

test("the vision pin is the spec's ModelCapabilities record with image_input naming its projector", () => {
  const record = ModelCapabilities.parse({
    id: STACK_VISION_MODEL.id, role: "vision", label: "Qwen3 VL 4B Instruct", license: STACK_VISION_MODEL.license, engine: "llama-server", implemented: true,
    download: STACK_VISION_MODEL.download,
    image_input: { projector: { file: STACK_VISION_PROJECTOR.download!.url.split("/").pop(), download: STACK_VISION_PROJECTOR.download } },
    sizing: { kind: "transformer_gguf", param_count_billion: 4.4, bits_per_weight: 4, num_layers: 36, num_kv_heads: 8, head_dim: 128, max_context: 262144 },
  });
  expect(record.image_input?.projector.file).toBe("mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf");
});

test("vision runs its own process, never chat's text-only one", () => {
  expect(processRoleFor("vision")).toBe("vision");
});

test("a vision record that does not declare picture input is never selected for vision (rule 8)", () => {
  install({ ...STACK_VISION_MODEL, id: "text-only-vision-lookalike", imageInput: undefined });
  expect(selectedModel("vision")).toBeNull();
  const model = install(STACK_VISION_MODEL);
  expect(declaresImageInput(model)).toBe(true);
  expect(selectedModel("vision")?.id).toBe(STACK_VISION_MODEL.id);
});

test("the projector is never selectable alone, and a vision model without its installed projector has none", () => {
  const model = install(STACK_VISION_MODEL);
  expect(projectorFor(model)).toBeNull();
  install(STACK_VISION_PROJECTOR);
  expect(projectorFor(model)?.id).toBe(STACK_VISION_PROJECTOR.id);
  expect(selectedModel("vision")?.id).toBe(STACK_VISION_MODEL.id);
});

test("an install by id carries picture input only for the pinned file, never from a caller's body", () => {
  const body = { id: STACK_VISION_MODEL.id, role: "vision" as const, url: STACK_VISION_MODEL.download!.url, sha256: STACK_VISION_MODEL.download!.sha256, licence: "Apache-2.0", revision: STACK_VISION_MODEL.revision! };
  expect(pullSpec(body).imageInput).toEqual({ projector: STACK_VISION_PROJECTOR.id });
  expect(pullSpec(body).launch).toEqual({ contextLength: 8192 });
  expect(pullSpec({ ...body, sha256: "f".repeat(64) }).imageInput).toBeUndefined();
  expect(pullSpec({ ...body, revision: "main" }).imageInput).toBeUndefined();
});

test("the vision probe sends a picture, so ready means the projector reads one", () => {
  const probe = probeRequest("vision");
  const content = (probe.body.messages as Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>)[0]!.content;
  expect(content[0]).toEqual({ type: "image_url", image_url: { url: VISION_PROBE_IMAGE } });
  expect(VISION_PROBE_IMAGE.startsWith("data:image/png;base64,")).toBe(true);
  expect(JSON.stringify(probeRequest("chat"))).not.toContain("image_url");
});

test("the pin's card sampling fills only what the request left out", () => {
  install(STACK_VISION_MODEL);
  expect(withPinSampling(STACK_VISION_MODEL.id, { model: "vision" })).toMatchObject({ temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5 });
  expect(withPinSampling(STACK_VISION_MODEL.id, { model: "vision", temperature: 0.2 })).toMatchObject({ temperature: 0.2, top_p: 0.8 });
  expect(withPinSampling(null, { model: "chat" })).toEqual({ model: "chat" });
});

test("a resident start unloads a loaded vision process first, so chat is sized without it (rule 4)", async () => {
  await getProcess("vision");
  expect(getRoleStatus("vision").state).toBe("ready");
  await restartRole("chat");
  await getProcess("chat");
  expect(started).toEqual(["vision", "chat"]);
  expect(getRoleStatus("vision").state).toBe("installed");
});

test("a vision start never touches a running chat", async () => {
  const chat = await getProcess("chat");
  await getProcess("vision");
  expect(await getProcess("chat")).toBe(chat);
  expect(started).toEqual(["chat", "vision"]);
});

test("the governor queues vision behind its margin and never evicts chat to admit it", async () => {
  // Chat was admitted on an emptier machine; the reading after its load
  // is what vision is measured against.
  const chatAdmitted = async () => {
    __setGovernorTuningForTestsOnly({ totalMemoryBytes: 24 * GB, freeMemoryBytes: 20 * GB, tier: "p16" });
    expect("id" in await admit({ id: "chat", kind: "resident", requestedBytes: 5 * GB, measuredPeakBytes: 8 * GB })).toBe(true);
  };
  await chatAdmitted();
  // 9 GB free less a 3.5 GB vision peak leaves 5.5 GB, over the 4 GB p16 margin: admitted.
  __setGovernorTuningForTestsOnly({ freeMemoryBytes: 9 * GB });
  expect("id" in await admit({ id: "vision", kind: "jit", requestedBytes: 3 * GB, measuredPeakBytes: 3.5 * GB })).toBe(true);
  __resetGovernorForTests();
  await chatAdmitted();
  // 6 GB free less 3.5 GB leaves 2.5 GB, under the margin: queued, chat stays.
  __setGovernorTuningForTestsOnly({ freeMemoryBytes: 6 * GB });
  expect(await admit({ id: "vision", kind: "jit", requestedBytes: 3 * GB, measuredPeakBytes: 3.5 * GB })).toMatchObject({ queued: true });
  expect(getGovernorStatus().loaded.map(({ id }) => id)).toEqual(["chat"]);
});

test("a jit item is evicted only by a watch that can unload it, and a request restarts its idle clock", async () => {
  let now = Date.parse("2026-10-06T12:00:00.000Z");
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 24 * GB, freeMemoryBytes: 12 * GB, tier: "p16", idleTtlSeconds: 600 });
  await admit({ id: "vision", kind: "jit", requestedBytes: 3 * GB, measuredPeakBytes: 3.5 * GB });
  const unloaded: string[] = [];
  // The daemon's own watch has no unload: it must not forget the item.
  now += 11 * 60_000;
  const daemonWatch = startGovernor({ pid: process.pid, now: () => now, freeMemory: () => 12 * GB, totalMemory: () => 24 * GB });
  await new Promise((resolve) => setTimeout(resolve, 20));
  daemonWatch();
  expect(getGovernorStatus().loaded.map(({ id }) => id)).toEqual(["vision"]);
  // A request now restarts the clock: not idle yet.
  touch("vision");
  now = Date.now() + 5 * 60_000;
  const early = startGovernor({ pid: -1, now: () => now, freeMemory: () => 12 * GB, totalMemory: () => 24 * GB, unload: (id) => { unloaded.push(id); } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  early();
  expect(unloaded).toEqual([]);
  now = Date.now() + 11 * 60_000;
  const late = startGovernor({ pid: -1, now: () => now, freeMemory: () => 12 * GB, totalMemory: () => 24 * GB, unload: (id) => { unloaded.push(id); } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  late();
  expect(unloaded).toEqual(["vision"]);
  expect(getGovernorStatus().loaded).toEqual([]);
});

test("the roles route says whether the bound vision model reads pictures", async () => {
  install(STACK_VISION_MODEL);
  install(STACK_VISION_PROJECTOR);
  const body = await (await app.request("/stack/v1/roles")).json() as { roles: Array<{ id: string; sharesModelWith?: string; model: { id: string; imageInput?: boolean } | null }> };
  const vision = body.roles.find((role) => role.id === "vision")!;
  expect(vision.sharesModelWith).toBeUndefined();
  expect(vision.model).toMatchObject({ id: STACK_VISION_MODEL.id, imageInput: true });
});

test("the roles route reports picture capability for a URL-bound vision engine", async () => {
  install(STACK_VISION_MODEL);
  updateSettings({ "stack.engines.vision.host_url": "http://127.0.0.1:9999" });
  applyPendingSettings();
  const body = await (await app.request("/stack/v1/roles")).json() as { roles: Array<{ id: string; model: { imageInput?: boolean } | null }> };
  expect(body.roles.find((role) => role.id === "vision")!.model?.imageInput).toBe(true);
});

// Review regressions (VISION-01b, medium review pass 1).

function gatedFactory(order: string[], gates: Partial<Record<string, Promise<void>>>) {
  setSupervisorFactoryForTests(async (role) => {
    order.push(`start ${role}`);
    await gates[role];
    order.push(`ready ${role}`);
    return scriptedProcess(role);
  });
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("a chat start never waits on a vision start that holds no admission, and that vision is not kept (rule 4)", async () => {
  const order: string[] = [];
  let finishVision!: () => void;
  gatedFactory(order, { vision: new Promise<void>((resolve) => { finishVision = resolve; }) });
  const vision = getProcess("vision").catch((error: Error) => error);
  await tick();
  await getProcess("chat");
  expect(order).toEqual(["start vision", "start chat", "ready chat"]);
  // The unwanted start is retired when it finishes; the waiting picture
  // request is served by a fresh start now that chat is already sized.
  finishVision();
  expect(await vision).not.toBeInstanceOf(Error);
  expect(order).toEqual(["start vision", "start chat", "ready chat", "ready vision", "start vision", "ready vision"]);
});

test("a chat start waits for an admitted vision load to be retired before it is sized (rule 4)", async () => {
  const order: string[] = [];
  let finishVision!: () => void;
  gatedFactory(order, { vision: new Promise<void>((resolve) => { finishVision = resolve; }) });
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 24 * GB, freeMemoryBytes: 20 * GB, tier: "p16" });
  const vision = getProcess("vision").catch((error: Error) => error);
  await tick();
  // The scripted start stands in for a spawned one that the governor admitted.
  await admit({ id: "vision", kind: "jit", requestedBytes: 3 * GB, measuredPeakBytes: 3.5 * GB });
  const chat = getProcess("chat");
  await tick();
  expect(order).toEqual(["start vision"]);
  finishVision();
  await chat;
  await vision;
  expect(order).toEqual(["start vision", "ready vision", "start chat", "ready chat"]);
});

test("a picture request while chat is starting is refused, never admitted beside it", async () => {
  const order: string[] = [];
  let finishChat!: () => void;
  gatedFactory(order, { chat: new Promise<void>((resolve) => { finishChat = resolve; }) });
  const chat = getProcess("chat");
  await tick();
  await expect(getProcess("vision")).rejects.toThrow(/waits while a resident engine starts/);
  finishChat();
  await chat;
  expect(order).toEqual(["start chat", "ready chat"]);
  await getProcess("vision");
  expect(order).toEqual(["start chat", "ready chat", "start vision", "ready vision"]);
});

test("a stale release frees nothing and admits nothing from the queue", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 24 * GB, freeMemoryBytes: 9 * GB, tier: "p16" });
  const old = await admit({ id: "vision", kind: "jit", requestedBytes: GB, measuredPeakBytes: GB }) as { id: string; kind: "jit"; requestedBytes: number; token: number };
  await admit({ id: "vision", kind: "jit", requestedBytes: GB, measuredPeakBytes: GB });
  __setGovernorTuningForTestsOnly({ freeMemoryBytes: 5 * GB });
  expect(await admit({ id: "chat", kind: "resident", requestedBytes: 5 * GB, measuredPeakBytes: 5 * GB })).toMatchObject({ queued: true });
  const { release } = await import("@/lib/governor");
  release(old);
  expect(getGovernorStatus().loaded.map(({ id }) => id)).toEqual(["vision"]);
  expect(getGovernorStatus().queue.map(({ id }) => id)).toEqual(["chat"]);
});

test("the governor leaves a jit item that is still starting counted, and evicts it once running", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 24 * GB, freeMemoryBytes: 20 * GB, tier: "p16", idleTtlSeconds: 1 });
  await admit({ id: "vision", kind: "jit", requestedBytes: GB, measuredPeakBytes: GB });
  let running = false;
  const asked: string[] = [];
  const now = Date.now() + 60_000;
  const stop = startGovernor({ pid: -1, pollMs: 2, now: () => now, freeMemory: () => 20 * GB, totalMemory: () => 24 * GB, unload: async (id) => { asked.push(id); return running; } });
  try {
    await tick(); await tick();
    expect(getGovernorStatus().loaded.map(({ id }) => id)).toEqual(["vision"]);
    running = true;
    await tick(); await tick();
    expect(getGovernorStatus().loaded).toEqual([]);
    expect(asked.length).toBeGreaterThan(1);
  } finally { stop(); }
});

test("a release with an older admission's handle never removes a newer admission under the same id", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 24 * GB, freeMemoryBytes: 20 * GB, tier: "p16" });
  const first = await admit({ id: "vision", kind: "jit", requestedBytes: GB, measuredPeakBytes: GB });
  const second = await admit({ id: "vision", kind: "jit", requestedBytes: GB, measuredPeakBytes: GB });
  expect("token" in first && "token" in second && first.token !== second.token).toBe(true);
  const { release } = await import("@/lib/governor");
  release(first as { id: string; kind: "jit"; requestedBytes: number; token: number });
  expect(getGovernorStatus().loaded.map(({ id }) => id)).toEqual(["vision"]);
  release(second as { id: string; kind: "jit"; requestedBytes: number; token: number });
  expect(getGovernorStatus().loaded).toEqual([]);
});

test("an eviction that drains a request never blocks the watch, is asked once, and leaves a newer admission counted", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 24 * GB, freeMemoryBytes: 20 * GB, tier: "p16", idleTtlSeconds: 1 });
  await admit({ id: "vision", kind: "jit", requestedBytes: GB, measuredPeakBytes: GB });
  let finishUnload!: () => void;
  const draining = new Promise<void>((resolve) => { finishUnload = resolve; });
  const asked: string[] = [];
  const now = Date.now() + 60_000;
  const stop = startGovernor({ pid: -1, pollMs: 2, now: () => now, freeMemory: () => 20 * GB, totalMemory: () => 24 * GB, unload: async (id) => { asked.push(id); await draining; } });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Several polls ran while the unload drained; it was asked once.
    expect(asked).toEqual(["vision"]);
    // A new picture request admitted a fresh process meanwhile.
    __resetGovernorForTests();
    __setGovernorTuningForTestsOnly({ totalMemoryBytes: 24 * GB, freeMemoryBytes: 20 * GB, tier: "p16" });
    await admit({ id: "vision", kind: "jit", requestedBytes: GB, measuredPeakBytes: GB });
    finishUnload();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(getGovernorStatus().loaded.map(({ id }) => id)).toEqual(["vision"]);
  } finally { stop(); }
});

test("an install whose file is the shipped vision pin keeps its declarations even when the Catalog index lists it without them", async () => {
  const { db } = await import("@/db");
  const { meta } = await import("@/db/schema");
  const index = JSON.stringify({ version: "1", models: [{ id: STACK_VISION_MODEL.id, role: "vision", profile: "p128", quality: 1, revision: STACK_VISION_MODEL.revision, download: { url: STACK_VISION_MODEL.download!.url, sha256: STACK_VISION_MODEL.download!.sha256, approx_bytes: STACK_VISION_MODEL.download!.approx_bytes } }] });
  db.insert(meta).values({ key: "updates.modelIndex.body", value: index }).onConflictDoUpdate({ target: meta.key, set: { value: index } }).run();
  try {
    const body = { id: STACK_VISION_MODEL.id, role: "vision" as const, url: STACK_VISION_MODEL.download!.url, sha256: STACK_VISION_MODEL.download!.sha256, licence: "Apache-2.0", revision: STACK_VISION_MODEL.revision! };
    expect(pullSpec(body).imageInput).toEqual({ projector: STACK_VISION_PROJECTOR.id });
  } finally {
    const { eq } = await import("drizzle-orm");
    db.delete(meta).where(eq(meta.key, "updates.modelIndex.body")).run();
  }
});
