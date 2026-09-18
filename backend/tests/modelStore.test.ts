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
  registerCatalogModel,
  upsertModel,
  ProvenanceIncompleteError,
} from "@/lib/modelStore";
import { STACK_CHAT_MODEL } from "@/lib/modelCatalog";
import { hfUrl } from "@/lib/hf";
import { downloadUrl } from "@/lib/download";
import { __resetStackSettingsForTests, updateStackConfig } from "@/settings/stackKeys";

const fixtureDir = join(tmpdir(), `maipai-stack-models-${Date.now()}`);

beforeEach(() => {
  clearModelsForTests();
  __resetStackSettingsForTests();
  mkdirSync(fixtureDir, { recursive: true });
});

afterEach(() => {
  clearModelsForTests();
  __resetStackSettingsForTests();
  rmSync(fixtureDir, { recursive: true, force: true });
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
    if (url.pathname === `/Qwen/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q8_0.gguf`) {
      return new Response(CONTENT, { status: 200, headers: { "content-length": String(CONTENT.length) } });
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => mirrorServer.stop(true));

test("a pinned catalog model downloads from the configured Hugging Face mirror", async () => {
  const mirror = new URL(mirrorServer.url).href.replace(/\/$/, "");
  updateStackConfig({ huggingFaceEndpoint: mirror });
  const expectedUrl = hfUrl("Qwen/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q8_0.gguf");
  expect(expectedUrl).toBe(`${mirror}/Qwen/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q8_0.gguf`);
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
  updateStackConfig({ huggingFaceEndpoint: mirror });
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
