// VISION-02b: Qwen3-VL-8B-Instruct as a chat model that reads pictures
// itself. Its projector loads beside it in the one resident chat process,
// the chat settings (slots) are kept, the fit plan counts the projector,
// and a measured footprint is never read above the context it was taken
// at. The p16 binding does not move here (the owner's go, VISION-02e).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelCapabilities } from "@maipai/spec/gen/ts/model-capabilities.js";
import { ENGINE_READY_MARKER, installedEnginePin } from "@/lib/engineCatalog";
import { engineDir } from "@/lib/engineInstall";
import { llamaServerArgs } from "@/lib/engineArgs";
import { buildFitPlan, largestAdmittedContext, parseGgufParserJson, type GgufEstimate } from "@/lib/fitPlan";
import { __resetGovernorForTests } from "@/lib/governor";
import { __resetHealthForTests } from "@/lib/health";
import { clearModelsForTests, registerCatalogModel, upsertModel, type CatalogModelLike } from "@/lib/modelStore";
import { STACK_CHAT_8B_MODEL, STACK_CHAT_VL_8B_MODEL, STACK_CHAT_VL_8B_PROJECTOR, STACK_MODELS, STACK_VISION_MODEL, STACK_VISION_PROJECTOR } from "@/lib/modelCatalog";
import { PROFILE_MODEL_BINDINGS } from "@/profiles";
import { getProcess, keepsMeasuredFootprint, launchPlan, launchProjectorFor, picturesProbeOk, resetSupervisorForTests, roleReadsPictures, scriptedProcess, selectedModel, setSupervisorFactoryForTests, VISION_PROBE_IMAGE, withPinSampling, type EngineClient } from "@/lib/supervisor";
import { pullSpec } from "@/routes/models";
import { app } from "@/app";
import { readFileSync } from "node:fs";

const verifiedAt = "2026-10-06T00:00:00.000Z";
const REVISION = "f982a07559d4a2f6c8744d840bf6fccab30eea96";

function install(pin: CatalogModelLike) {
  const registered = registerCatalogModel(pin);
  return upsertModel({ ...registered, verifiedAt, modelPath: join("/tmp", `${pin.id}.gguf`) });
}

beforeEach(() => {
  clearModelsForTests();
  __resetHealthForTests();
  __resetGovernorForTests();
});
afterEach(() => { setSupervisorFactoryForTests(null); resetSupervisorForTests(); clearModelsForTests(); __resetGovernorForTests(); });

test("the VL-8B chat pins are Apache-2.0 at one Hub revision with the sizes and hashes of that revision", () => {
  expect(STACK_MODELS).toEqual(expect.arrayContaining([STACK_CHAT_VL_8B_MODEL, STACK_CHAT_VL_8B_PROJECTOR]));
  for (const pin of [STACK_CHAT_VL_8B_MODEL, STACK_CHAT_VL_8B_PROJECTOR]) {
    expect(pin.role).toBe("chat");
    expect(pin.license).toBe("Apache-2.0");
    expect(pin.repo).toBe("Qwen/Qwen3-VL-8B-Instruct-GGUF");
    expect(pin.revision).toBe(REVISION);
    expect(pin.download!.url).toContain(`/resolve/${REVISION}/`);
  }
  expect(STACK_CHAT_VL_8B_MODEL.download).toMatchObject({ sha256: "67d1659bfe71b89d50b45a4ad1a9e5b997e5bb16ce5da66a6a6167abd569e9e2", approx_bytes: 5_027_784_800 });
  expect(STACK_CHAT_VL_8B_PROJECTOR.download).toMatchObject({ sha256: "c6ba85508d82f42590e6eb77d5340369ab6fecf107a7561d809523d8aa5f3bfd", approx_bytes: 752_289_728 });
  expect(STACK_CHAT_VL_8B_PROJECTOR.component).toBe("projector");
  expect(STACK_CHAT_VL_8B_MODEL.imageInput).toEqual({ projector: STACK_CHAT_VL_8B_PROJECTOR.id });
  expect(STACK_CHAT_VL_8B_MODEL.sampling?.source).toBe("Qwen/Qwen3-VL-8B-Instruct-GGUF model card, Generation Hyperparameters, VL");
});

test("the VL-8B pin is the spec's chat record with image_input and no thinking mode", () => {
  const record = ModelCapabilities.parse({
    id: STACK_CHAT_VL_8B_MODEL.id, role: "chat", label: "Qwen3 VL 8B Instruct", license: STACK_CHAT_VL_8B_MODEL.license, engine: "llama-server", implemented: true,
    download: STACK_CHAT_VL_8B_MODEL.download,
    image_input: { projector: { file: STACK_CHAT_VL_8B_PROJECTOR.download!.url.split("/").pop(), download: STACK_CHAT_VL_8B_PROJECTOR.download } },
    thinking_mode: "none",
    sizing: { kind: "transformer_gguf", param_count_billion: 8.8, bits_per_weight: 4, num_layers: 36, num_kv_heads: 8, head_dim: 128, max_context: 262144 },
  });
  expect(record.image_input?.projector.file).toBe("mmproj-Qwen3VL-8B-Instruct-Q8_0.gguf");
});

test("the p16 chat binding stays Qwen3-8B until the owner's go (VISION-02e)", () => {
  expect(PROFILE_MODEL_BINDINGS.p16?.chat).toBe(STACK_CHAT_8B_MODEL.id);
});

test("an install by id carries picture input and card sampling only for the pinned file", () => {
  const body = { id: STACK_CHAT_VL_8B_MODEL.id, role: "chat" as const, url: STACK_CHAT_VL_8B_MODEL.download!.url, sha256: STACK_CHAT_VL_8B_MODEL.download!.sha256, licence: "Apache-2.0", revision: REVISION };
  expect(pullSpec(body).imageInput).toEqual({ projector: STACK_CHAT_VL_8B_PROJECTOR.id });
  expect(pullSpec(body).sampling?.top_k).toBe(20);
  expect(pullSpec(body).launch).toEqual({ imageMaxTokens: 2560 });
  expect(pullSpec({ ...body, sha256: "f".repeat(64) }).imageInput).toBeUndefined();
});

test("the projector is a component: never the chat model itself, found only once installed", () => {
  const model = install(STACK_CHAT_VL_8B_MODEL);
  install(STACK_CHAT_8B_MODEL);
  expect(launchProjectorFor("chat", model)).toBeNull();
  install(STACK_CHAT_VL_8B_PROJECTOR);
  expect(launchProjectorFor("chat", model)?.id).toBe(STACK_CHAT_VL_8B_PROJECTOR.id);
  expect(selectedModel("chat")?.id).not.toBe(STACK_CHAT_VL_8B_PROJECTOR.id);
  // A text-only chat model has no projector, and an embed launch never takes one.
  expect(launchProjectorFor("chat", install(STACK_CHAT_8B_MODEL))).toBeNull();
  expect(launchProjectorFor("embed", model)).toBeNull();
});

test("a chat launch with a projector keeps its declared slots; the vision role stays one slot (the two dropped settings)", () => {
  const config = { slots: 2, contextLength: 0 };
  const chat = llamaServerArgs({ modelPath: "/models/vl.gguf", port: 8771, config, contextLength: 40960, kvCacheType: "q8_0", projectorPath: "/models/mmproj.gguf" });
  expect(chat[chat.indexOf("--mmproj") + 1]).toBe("/models/mmproj.gguf");
  expect(chat.slice(chat.indexOf("--parallel"), chat.indexOf("--parallel") + 2)).toEqual(["--parallel", "2"]);
  // b10797 turns chunk reuse off itself with a projector (measured); it is
  // not asked for, and a text launch keeps it.
  expect(chat).not.toContain("--cache-reuse");
  expect(llamaServerArgs({ modelPath: "/models/t.gguf", port: 8771, config, contextLength: 40960, kvCacheType: "q8_0" })).toContain("--cache-reuse");
  const vision = llamaServerArgs({ modelPath: "/models/vl.gguf", port: 8772, config, contextLength: 8192, kvCacheType: "q8_0", projectorPath: "/models/mmproj.gguf", onePictureSlot: true });
  expect(vision.slice(vision.indexOf("--parallel"), vision.indexOf("--parallel") + 2)).toEqual(["--parallel", "1"]);
});

const APPLE_SILICON = process.platform === "darwin" && process.arch === "arm64";

test.skipIf(!APPLE_SILICON)("the chat launch plan loads the projector when installed and starts text-only when it is not", async () => {
  const pin = installedEnginePin()!;
  mkdirSync(engineDir(pin), { recursive: true });
  writeFileSync(join(engineDir(pin), "llama-server"), "");
  writeFileSync(join(engineDir(pin), ENGINE_READY_MARKER), "now");
  try {
    const model = install(STACK_CHAT_VL_8B_MODEL);
    const textOnly = await launchPlan("chat", model, 8797, 40960);
    expect(textOnly.command).not.toContain("--mmproj");
    expect(textOnly.imageInput).toBe(false);
    install(STACK_CHAT_VL_8B_PROJECTOR);
    const reads = await launchPlan("chat", model, 8797, 40960);
    expect(reads.command[reads.command.indexOf("--mmproj") + 1]).toBe(join("/tmp", `${STACK_CHAT_VL_8B_PROJECTOR.id}.gguf`));
    expect(reads.imageInput).toBe(true);
    // One picture's cost in the window is bounded by the record's own number.
    expect(reads.command[reads.command.indexOf("--image-max-tokens") + 1]).toBe("2560");
    expect(reads.pictureTokensMax).toBe(2560);
    expect(textOnly.command).not.toContain("--image-max-tokens");
    // The vision role's own pin is untouched: its projector, one slot.
    install(STACK_VISION_PROJECTOR);
    const vision = await launchPlan("vision", install(STACK_VISION_MODEL), 8798);
    expect(vision.command[vision.command.indexOf("--parallel") + 1]).toBe("1");
  } finally {
    rmSync(join(engineDir(pin), ".."), { recursive: true, force: true });
  }
});

test("the chat role row says it reads pictures only when its process was launched with the projector", async () => {
  install(STACK_CHAT_VL_8B_MODEL);
  install(STACK_CHAT_VL_8B_PROJECTOR);
  setSupervisorFactoryForTests(async (role) => scriptedProcess(role, { kind: "spawned", imageInput: false }));
  await getProcess("chat");
  const row = async () => ((await (await app.request("/stack/v1/roles")).json()) as { roles: Array<{ id: string; model: { imageInput?: boolean } | null }> }).roles.find((role) => role.id === "chat")!;
  expect((await row()).model?.imageInput).toBe(false);
  resetSupervisorForTests();
  setSupervisorFactoryForTests(async (role) => scriptedProcess(role, { kind: "spawned", imageInput: true }));
  await getProcess("chat");
  expect((await row()).model?.imageInput).toBe(true);
  resetSupervisorForTests();
  setSupervisorFactoryForTests(async (role) => scriptedProcess(role, { kind: "spawned", imageInput: true, pictureTokensMax: 2560 }));
  await getProcess("chat");
  expect(((await row()) as unknown as { picture_tokens_max: number | null }).picture_tokens_max).toBe(2560);
  expect(roleReadsPictures("chat", selectedModel("chat"))).toBe(true);
});

test("a failed picture check leaves chat serving text: the probe answers false, never throws", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const client = (status: number, content: string): EngineClient => ({
    baseUrl: "in-process://probe",
    async request(_path, body) { sent.push(body); return { status, body: { choices: [{ message: { content } }] } }; },
    async health() { return true; },
  });
  expect(await picturesProbeOk(client(200, "Red"))).toBe(true);
  expect(await picturesProbeOk(client(500, ""))).toBe(false);
  expect(await picturesProbeOk({ baseUrl: "x", async request() { throw new Error("connection reset"); }, async health() { return false; } })).toBe(false);
  const content = (sent[0]!.messages as Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>)[0]!.content;
  expect(content[0]).toEqual({ type: "image_url", image_url: { url: VISION_PROBE_IMAGE } });
  expect(sent[0]!.model).toBe("chat");
});

test("the card's VL sampling fills only what Home left out", () => {
  install(STACK_CHAT_VL_8B_MODEL);
  expect(withPinSampling(STACK_CHAT_VL_8B_MODEL.id, { model: "chat", temperature: 0.7 })).toMatchObject({ temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5 });
  expect(withPinSampling(STACK_CHAT_VL_8B_MODEL.id, { model: "chat", presence_penalty: 0 })).toMatchObject({ presence_penalty: 0 });
});

const estimate = parseGgufParserJson(readFileSync(join(import.meta.dir, "fixtures/gguf-parser-qwen3-1.7b-4096.json"), "utf8"))!;
const KV_PER_TOKEN = 150_000;
const WEIGHTS = 5_000_000_000;
const at = (contextTokens: number): GgufEstimate => ({ ...estimate, contextTokens, architecture: "qwen3", expertCount: 0, fullOffloaded: true, vramNonumaBytes: WEIGHTS + contextTokens * KV_PER_TOKEN, vramUmaBytes: 0, ramNonumaBytes: WEIGHTS + contextTokens * KV_PER_TOKEN, ramUmaBytes: 0 });
const plan = (capBytes: number, measured: { bytes: number; context: number | null } | null) => largestAdmittedContext({
  modelId: "vl", kvCacheType: "q8_0", unifiedMemory: true, deviceBudgetsBytes: [], capBytes, workingMarginBytes: 0, asOf: "2026-10-06", tool: { name: "gguf-parser", version: "test" },
  estimate: null, modelContextTokens: 262_144, estimateAt: at,
  measuredPeakBytes: measured?.bytes ?? null, measuredContextTokens: measured?.context ?? null,
});

test("a footprint measured at 40,960 is never read as the cost of 262,144 (the model's own maximum)", async () => {
  // Room for about 60,000 tokens: the estimate decides above the measured context.
  const cap = WEIGHTS + 60_000 * KV_PER_TOKEN;
  const measured = { bytes: WEIGHTS + 40_960 * KV_PER_TOKEN, context: 40_960 };
  const chosen = await plan(cap, measured);
  expect(chosen.contextTokens).toBeLessThan(262_144);
  expect(chosen.contextTokens).toBeGreaterThanOrEqual(40_960);
  expect(chosen.contextTokens).toBeLessThanOrEqual(60_000);
  // Without the measured figure the estimate alone gives the same answer.
  expect((await plan(cap, null)).contextTokens).toBe(chosen.contextTokens);
  // At or below the measured context, the measured figure still holds.
  const tight = await plan(WEIGHTS + 40_960 * KV_PER_TOKEN + 1, { bytes: WEIGHTS + 1_000, context: 40_960 });
  expect(tight.plan.roles[0]?.peak.source).toBe("measured");
});

test("the qwen3vl text model is planned from its estimate, never from the context-free file-size fallback", () => {
  const input = { modelId: "vl", modelFileBytes: WEIGHTS, kvCacheType: "q8_0" as const, unifiedMemory: true, deviceBudgetsBytes: [], capBytes: 64 * 1024 ** 3, workingMarginBytes: 0, asOf: "2026-10-06", tool: { name: "gguf-parser", version: "test" }, contextTokens: 262_144 };
  const vl = buildFitPlan({ ...input, estimate: { ...at(262_144), architecture: "qwen3vl" } });
  expect(vl.roles[0]?.peak.high).toBe(WEIGHTS + 262_144 * KV_PER_TOKEN);
});

test("a picture-reading model launched without its projector does not store that smaller reading (a review)", () => {
  const vl = install(STACK_CHAT_VL_8B_MODEL);
  expect(keepsMeasuredFootprint(vl, false)).toBe(false);
  expect(keepsMeasuredFootprint(vl, true)).toBe(true);
  expect(keepsMeasuredFootprint(install(STACK_CHAT_8B_MODEL), false)).toBe(true);
});

test("the components inventory shows the bound chat model per tier and lists the VL-8B as also pinned", async () => {
  const { collectComponentsCatalog, renderComponentsDoc } = await import("@/lib/componentsDoc");
  const doc = renderComponentsDoc(collectComponentsCatalog());
  const chat = doc.slice(doc.indexOf("## chat"), doc.indexOf("## coding"));
  expect(chat).toContain("| p16 | resident | `qwen3-8b-instruct-q4-k-m` |");
  expect(chat).toMatch(/Also pinned, started only when chosen[^\n]*`qwen3-vl-8b-instruct-q4-k-m` \([^)]*reads pictures\)/);
});

test("the chat and vision role rows say whether they read pictures, and no other row does", async () => {
  type Row = { id: string; reads_pictures?: boolean };
  const rows = async () => ((await (await app.request("/stack/v1/roles")).json()) as { roles: Row[] }).roles;
  const find = async (id: string) => (await rows()).find((role) => role.id === id)!;
  // The p16 chat binding is the text-only Qwen3-8B: it reads no pictures.
  install(STACK_CHAT_8B_MODEL);
  expect((await find("chat")).reads_pictures).toBe(false);
  // A launched process with a projector reads pictures, on chat and on vision.
  setSupervisorFactoryForTests(async (role) => scriptedProcess(role, { kind: "spawned", imageInput: true }));
  await getProcess("chat");
  expect((await find("chat")).reads_pictures).toBe(true);
  resetSupervisorForTests();
  setSupervisorFactoryForTests(async (role) => scriptedProcess(role, { kind: "spawned", imageInput: true }));
  await getProcess("vision");
  expect((await find("vision")).reads_pictures).toBe(true);
  expect((await find("embed")).reads_pictures).toBeUndefined();
});
