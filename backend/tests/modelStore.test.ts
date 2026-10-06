import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearModelsForTests,
  getModel,
  installCatalogModel,
  installHuggingFaceModel,
  isModelSelectable,
  MEASURED_MEMORY_DEFINITION,
  recordMeasuredFootprint,
  registerCatalogModel,
  upgradeMeasuredFiguresFromOlderDefinition,
  upsertModel,
  ProvenanceIncompleteError,
} from "@/lib/modelStore";
import { STACK_CHAT_8B_MODEL, STACK_CHAT_MODEL, STACK_EMBED_MODEL, STACK_JUDGE_MODEL, STACK_MODELS } from "@/lib/modelCatalog";
import { hfUrl } from "@/lib/hf";
import { downloadUrl } from "@/lib/download";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { __resetSettingsForTests, updateSettings } from "@/settings";
import { processRoleFor, selectedModel, setMachineTier } from "@/lib/supervisor";

const fixtureDir = join(tmpdir(), `maipai-stack-models-${Date.now()}`);

beforeEach(() => {
  clearModelsForTests();
  __resetSettingsForTests();
  mkdirSync(fixtureDir, { recursive: true });
});

afterEach(() => {
  setMachineTier(null);
  clearModelsForTests();
  __resetSettingsForTests();
  rmSync(fixtureDir, { recursive: true, force: true });
});

test("every shipped model pin registers through the catalog model boundary", () => {
  for (const pin of STACK_MODELS) {
    expect(registerCatalogModel(pin).id).toBe(pin.id);
  }
});

test("the household chat and judge pins match Home's hashes and file sizes", () => {
  expect(STACK_MODELS).toEqual(expect.arrayContaining([STACK_CHAT_8B_MODEL, STACK_JUDGE_MODEL]));
  expect(STACK_CHAT_8B_MODEL.download).toMatchObject({
    sha256: "d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785",
    approx_bytes: 5_027_783_488,
  });
  expect(STACK_JUDGE_MODEL.download).toMatchObject({
    sha256: "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",
    approx_bytes: 2_497_280_256,
  });
});

test("p16 judge shares the household 8B chat while p32 selects its separate 4B judge", () => {
  const install = (pin: typeof STACK_CHAT_MODEL | typeof STACK_CHAT_8B_MODEL | typeof STACK_JUDGE_MODEL) => upsertModel({
    id: pin.id,
    roles: [pin.role],
    source: "catalog",
    provenance: { package: `model:${pin.id}`, catalogId: pin.id },
    revision: pin.revision!,
    sha256: pin.download!.sha256,
    sizeBytes: pin.download!.approx_bytes,
    licence: pin.license!,
    engineRequirements: { engine: pin.engine, sizing: pin.sizing },
    verifiedAt: "2026-10-01T00:00:00.000Z",
    modelPath: join(fixtureDir, `${pin.id}.gguf`),
  });
  const small = install(STACK_CHAT_MODEL);
  const chat = install(STACK_CHAT_8B_MODEL);
  const judge = install(STACK_JUDGE_MODEL);
  setMachineTier("p16");
  expect(selectedModel("chat")?.id).toBe(chat.id);
  expect(selectedModel("judge")?.id).toBe(chat.id);
  expect(processRoleFor("judge")).toBe("chat");
  setMachineTier("p32");
  expect(selectedModel("chat")?.id).toBe(chat.id);
  expect(selectedModel("judge")?.id).toBe(judge.id);
  expect(processRoleFor("judge")).toBe("judge");
  setMachineTier(null);
  expect(selectedModel("chat")?.id).toBe(small.id);
  expect(processRoleFor("judge")).toBe("chat");
});

test("model records round-trip provenance and preserve the first-boot clock", () => {
  const first = upsertModel({
    id: "chat-one",
    roles: ["chat"],
    source: "catalog",
    provenance: { package: "model:chat-one", publisher: "MaiPai" },
    revision: "rev-a",
    sha256: "a".repeat(64),
    sizeBytes: 42,
    licence: "Apache-2.0",
    engineRequirements: { engine: "llama-server" },
  }, "2026-09-17T10:00:00.000Z");
  const updated = upsertModel({ ...first, revision: "rev-b" }, "2026-09-18T10:00:00.000Z");
  expect(getModel("chat-one")).toEqual({ ...updated, firstBootAt: "2026-09-17T10:00:00.000Z" });
});

test("the catalog includes the household embedding pin with its exact checksum and size", () => {
  const embed = STACK_MODELS.find((model) => model.id === "nomic-embed-text-v1-5-q4-k-m");
  expect(embed).toEqual(STACK_EMBED_MODEL);
  expect(embed?.download).toMatchObject({
    sha256: "d4e388894e09cf3816e8b0896d81d265b55e7a9fff9ab03fe8bf4ef5e11295ac",
    approx_bytes: 84_106_624,
  });
});

test("the embed role selects its installed p16 pin", () => {
  registerCatalogModel(STACK_EMBED_MODEL);
  const pin = STACK_EMBED_MODEL;
  const installed = upsertModel({
    id: pin.id,
    roles: ["embed"],
    source: "catalog",
    provenance: { package: `model:${pin.id}`, catalogId: pin.id, repo: pin.repo },
    revision: "0188c9bf409793f810680a5a431e7b899c46104c",
    sha256: "d4e388894e09cf3816e8b0896d81d265b55e7a9fff9ab03fe8bf4ef5e11295ac",
    sizeBytes: 84_106_624,
    licence: "Apache-2.0",
    engineRequirements: { engine: "llama-server", sizing: { profile: "p16", quantization: "q4_k_m" } },
    verifiedAt: "2026-10-01T00:00:00.000Z",
    modelPath: join(fixtureDir, "embed.gguf"),
  });
  expect(selectedModel("embed")?.id).toBe(installed.id);
});

test("Catalog ingestion retains its package provenance and verifies an install", async () => {
  const ggufHash = createHash("sha256").update("gguf").digest("hex");
  const model = {
    id: "catalog-chat",
    role: "chat" as const,
    license: "Apache-2.0",
    engine: "llama-server",
    revision: "catalog-rev",
    download: { url: "https://catalog.test/chat.gguf", sha256: ggufHash, approx_bytes: 3 },
  };
  const registered = registerCatalogModel(model, "2026-09-17T11:00:00.000Z");
  expect(registered.source).toBe("catalog");
  expect(registered.provenance).toEqual({ package: "model:catalog-chat", catalogId: "catalog-chat" });
  expect(isModelSelectable(registered)).toBe(false);

  const installed = await installCatalogModel(model, {
    destination: join(fixtureDir, "catalog.gguf"),
    now: () => "2026-09-17T11:01:00.000Z",
    download: async (_url, destination, options) => {
      expect(options.expectedSha256).toBe(ggufHash);
      writeFileSync(destination, "gguf");
    },
  });
  expect(installed.verifiedAt).toBe("2026-09-17T11:01:00.000Z");
  expect(isModelSelectable(installed)).toBe(true);
});

test("catalog installation forwards download progress for the live feed", async () => {
  const ggufHash = createHash("sha256").update("gguf").digest("hex");
  const progress: Array<{ completedBytes: number; totalBytes: number; status: string }> = [];
  await installCatalogModel({
    id: "progress-chat",
    role: "chat",
    license: "Apache-2.0",
    revision: "progress-rev",
    download: { url: "https://catalog.test/progress.gguf", sha256: ggufHash, approx_bytes: 4 },
  }, {
    destination: join(fixtureDir, "progress.gguf"),
    onProgress: (next) => progress.push(next),
    download: async (_url, destination, options) => {
      options.onProgress?.({ completedBytes: 2, totalBytes: 4, status: "downloading" });
      writeFileSync(destination, "gguf");
    },
  });
  expect(progress).toEqual([{ completedBytes: 2, totalBytes: 4, status: "downloading" }]);
});

test("Hugging Face installation records repo and revision", async () => {
  const ggufHash = createHash("sha256").update("gguf").digest("hex");
  const installed = await installHuggingFaceModel({
    id: "hf-chat",
    roles: ["chat"],
    repo: "Qwen/Qwen3-8B-GGUF",
    revision: "7c41481f",
    sha256: ggufHash,
    sizeBytes: 4,
    licence: "Apache-2.0",
  }, {
    destination: join(fixtureDir, "hf.gguf"),
    now: () => "2026-09-17T11:02:00.000Z",
    download: async (_url, destination) => writeFileSync(destination, "gguf"),
  });
  expect(installed.source).toBe("huggingface");
  expect(installed.provenance).toEqual({ repo: "Qwen/Qwen3-8B-GGUF", revision: "7c41481f" });
  expect(isModelSelectable(installed)).toBe(true);
});

test("a missing checksum or licence is never selectable", () => {
  const checksumMissing = upsertModel({
    id: "no-checksum",
    roles: ["chat"],
    source: "huggingface",
    provenance: { repo: "example/model" },
    revision: "main",
    licence: "Apache-2.0",
    verifiedAt: "2026-09-17T11:03:00.000Z",
  });
  const licenceMissing = upsertModel({
    id: "no-licence",
    roles: ["chat"],
    source: "catalog",
    provenance: { package: "model:no-licence" },
    revision: "rev",
    sha256: "d".repeat(64),
    verifiedAt: "2026-09-17T11:03:00.000Z",
  });
  expect(isModelSelectable(checksumMissing)).toBe(false);
  expect(isModelSelectable(licenceMissing)).toBe(false);
});

test("re-registering an installed catalog model preserves its install", () => {
  const installed = upsertModel({
    id: "catalog-installed",
    roles: ["chat"],
    source: "catalog",
    provenance: { package: "model:catalog-installed" },
    revision: "rev-a",
    sha256: "e".repeat(64),
    licence: "Apache-2.0",
    installedAt: "2026-09-17T12:00:00.000Z",
    verifiedAt: "2026-09-17T12:00:00.000Z",
    modelPath: "/models/catalog-installed.gguf",
  });
  const reregistered = registerCatalogModel({
    id: "catalog-installed",
    role: "chat",
    license: "Apache-2.0",
    revision: "rev-b",
    download: { url: "https://catalog.test/catalog-installed.gguf", sha256: "f".repeat(64), approx_bytes: 10 },
  });
  expect(reregistered.installedAt).toBe(installed.installedAt);
  expect(reregistered.verifiedAt).toBe(installed.verifiedAt);
  expect(reregistered.modelPath).toBe(installed.modelPath);
});

test("an incorrect existing model file is replaced and verified by hash", async () => {
  const contents = "correct model bytes";
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const destination = join(fixtureDir, "existing.gguf");
  writeFileSync(destination, "wrong model bytes");
  const installed = await installCatalogModel({
    id: "existing-model",
    role: "chat",
    license: "Apache-2.0",
    revision: "rev",
    download: { url: "https://catalog.test/existing.gguf", sha256, approx_bytes: contents.length },
  }, {
    destination,
    download: async (_url, path) => writeFileSync(path, contents),
  });
  expect(installed.verifiedAt).toBeTruthy();
  expect(await Bun.file(destination).text()).toBe(contents);
});

test("a corrupt downloaded model is never marked verified", async () => {
  const contents = "correct model bytes";
  const destination = join(fixtureDir, "corrupt.gguf");
  await expect(installCatalogModel({
    id: "corrupt-model",
    role: "chat",
    license: "Apache-2.0",
    revision: "rev",
    download: { url: "https://catalog.test/corrupt.gguf", sha256: createHash("sha256").update(contents).digest("hex"), approx_bytes: contents.length },
  }, {
    destination,
    download: async (_url, path) => writeFileSync(path, "still corrupt"),
  })).rejects.toThrow();
  expect(getModel("corrupt-model")?.verifiedAt).toBeNull();
});

const CONTENT = Buffer.from("x".repeat(40_000), "utf8");
const MIRROR_SHA256 = createHash("sha256").update(CONTENT).digest("hex");
const mirrorServer = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === `/Qwen/Qwen3-1.7B-GGUF/resolve/${STACK_CHAT_MODEL.revision}/Qwen3-1.7B-Q8_0.gguf`) {
      return new Response(CONTENT, { status: 200, headers: { "content-length": String(CONTENT.length) } });
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => mirrorServer.stop(true));

test("a pinned catalog model downloads from the configured Hugging Face mirror", async () => {
  const mirror = new URL(mirrorServer.url).href.replace(/\/$/, "");
  updateSettings({ "stack.updates.model_host": mirror });
  const expectedUrl = hfUrl(`Qwen/Qwen3-1.7B-GGUF/resolve/${STACK_CHAT_MODEL.revision}/Qwen3-1.7B-Q8_0.gguf`);
  expect(expectedUrl).toBe(`${mirror}/Qwen/Qwen3-1.7B-GGUF/resolve/${STACK_CHAT_MODEL.revision}/Qwen3-1.7B-Q8_0.gguf`);
  let requestedUrl = "";
  await installCatalogModel({
    id: "mirror-chat",
    role: "chat",
    license: STACK_CHAT_MODEL.license,
    revision: STACK_CHAT_MODEL.revision,
    engine: STACK_CHAT_MODEL.engine,
    download: { url: expectedUrl, sha256: MIRROR_SHA256, approx_bytes: CONTENT.length },
  }, {
    destination: join(fixtureDir, "mirror.gguf"),
    download: async (url, destination, options) => { requestedUrl = url; await downloadUrl(url, destination, options); },
  });
  expect(requestedUrl).toBe(expectedUrl);
  expect(getModel("mirror-chat")?.verifiedAt).toBeTruthy();
  expect(readFileSync(join(fixtureDir, "mirror.gguf"))).toEqual(CONTENT);
});

test("an incomplete Hugging Face provenance record throws before writing", async () => {
  const mirror = new URL(mirrorServer.url).href.replace(/\/$/, "");
  updateSettings({ "stack.updates.model_host": mirror });
  const incompleteUrl = hfUrl("example/model/resolve/main/incomplete.gguf");
  await expect(installHuggingFaceModel({
    id: "hf-incomplete",
    roles: ["chat"],
    repo: "example/model",
    revision: "main",
    url: incompleteUrl,
    licence: "Apache-2.0",
  }, { destination: join(fixtureDir, "incomplete.gguf") })).rejects.toThrow(ProvenanceIncompleteError);
});

test("a model size estimate is advisory when its hash matches", async () => {
  const contents = "four bytes";
  const sha256 = createHash("sha256").update(contents).digest("hex");
  let expectedBytes: number | undefined = 0;
  await installCatalogModel({
    id: "advisory-size",
    role: "chat",
    license: "Apache-2.0",
    revision: "rev",
    download: { url: "https://catalog.test/advisory.gguf", sha256, approx_bytes: 1 },
  }, {
    destination: join(fixtureDir, "advisory.gguf"),
    download: async (_url, path, options) => { expectedBytes = options.expectedBytes; writeFileSync(path, contents); },
  });
  expect(expectedBytes).toBeUndefined();
});

test("a footprint-only figure for a GGUF gains its mapped weights once; other figures and new ones are kept", () => {
  // The 8B chat's stored figure on 2026-10-06: the macOS footprint alone,
  // 3,379,206,840 bytes, while 8,382,824,448 were resident with the
  // 5,027,783,488-byte GGUF mapped.
  upsertModel({ id: "chat-8b", roles: ["chat"], source: "catalog", provenance: { package: "model:chat-8b" }, revision: "rev-a", sizeBytes: 5_027_783_488, modelPath: "/models/chat-8b/Qwen3-8B-Q4_K_M.gguf", measuredFootprintBytes: 3_379_206_840, measuredContextLength: 40_960 }, "2026-10-06T13:00:00.000Z");
  upsertModel({ id: "stt-one", roles: ["stt"], source: "catalog", provenance: { package: "model:stt-one" }, revision: "rev-a", sizeBytes: 107_600_538, modelPath: "/models/stt-one", measuredFootprintBytes: 260_097_296, measuredContextLength: 4096 }, "2026-10-06T13:00:00.000Z");
  db.delete(meta).where(eq(meta.key, "models.measured_memory_definition")).run();
  expect(upgradeMeasuredFiguresFromOlderDefinition()).toBe(1);
  expect(getModel("chat-8b")).toMatchObject({ measuredFootprintBytes: 8_406_990_328, measuredContextLength: 40_960 });
  expect(getModel("stt-one")).toMatchObject({ measuredFootprintBytes: 260_097_296 });
  expect(db.select().from(meta).where(eq(meta.key, "models.measured_memory_definition")).get()?.value).toBe(MEASURED_MEMORY_DEFINITION);
  // Once marked, a start changes nothing, and a new reading is stored as read.
  expect(upgradeMeasuredFiguresFromOlderDefinition()).toBe(0);
  recordMeasuredFootprint("chat-8b", 8_382_824_448, 40_960);
  expect(upgradeMeasuredFiguresFromOlderDefinition()).toBe(0);
  expect(getModel("chat-8b")).toMatchObject({ measuredFootprintBytes: 8_382_824_448, measuredContextLength: 40_960 });
});

test("a marked macOS store upgrades a GGUF figure an older build wrote below its file size, and only that", () => {
  // 2026-10-06: the new build marked the store, the Stack was rolled back,
  // and the old build stored the 8B chat's footprint again, 3,406,895,800
  // bytes, under the mark. The next start on the new build must not admit
  // the chat at that figure.
  upsertModel({ id: "chat-8b", roles: ["chat"], source: "catalog", provenance: { package: "model:chat-8b" }, revision: "rev-a", sizeBytes: 5_027_783_488, modelPath: "/models/chat-8b/Qwen3-8B-Q4_K_M.gguf", measuredFootprintBytes: 8_382_824_448, measuredContextLength: 40_960 }, "2026-10-06T13:00:00.000Z");
  upsertModel({ id: "judge-4b", roles: ["judge"], source: "catalog", provenance: { package: "model:judge-4b" }, revision: "rev-a", sizeBytes: 2_497_280_256, modelPath: "/models/judge-4b/Qwen3-4B-Q4_K_M.gguf", measuredFootprintBytes: 2_987_967_672, measuredContextLength: 4096 }, "2026-10-06T13:00:00.000Z");
  recordMeasuredFootprint("chat-8b", 3_406_895_800, 40_960);
  expect(db.select().from(meta).where(eq(meta.key, "models.measured_memory_definition")).get()?.value).toBe(MEASURED_MEMORY_DEFINITION);
  expect(upgradeMeasuredFiguresFromOlderDefinition("linux")).toBe(0);
  expect(getModel("chat-8b")).toMatchObject({ measuredFootprintBytes: 3_406_895_800 });
  expect(upgradeMeasuredFiguresFromOlderDefinition("darwin")).toBe(1);
  expect(getModel("chat-8b")).toMatchObject({ measuredFootprintBytes: 8_434_679_288, measuredContextLength: 40_960 });
  expect(getModel("judge-4b")).toMatchObject({ measuredFootprintBytes: 2_987_967_672 });
  // The upgraded figure is above the file size, so the next start keeps it.
  expect(upgradeMeasuredFiguresFromOlderDefinition("darwin")).toBe(0);
});
