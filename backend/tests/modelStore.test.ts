import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
} from "@/lib/modelStore";

const fixtureDir = join(tmpdir(), `maipai-stack-models-${Date.now()}`);

beforeEach(() => {
  clearModelsForTests();
  mkdirSync(fixtureDir, { recursive: true });
});

afterEach(() => {
  clearModelsForTests();
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
  const model = {
    id: "catalog-chat",
    role: "chat" as const,
    license: "Apache-2.0",
    engine: "llama-server",
    revision: "catalog-rev",
    download: { url: "https://catalog.test/chat.gguf", sha256: "b".repeat(64), approx_bytes: 3 },
  };
  const registered = registerCatalogModel(model, "2026-09-17T11:00:00.000Z");
  expect(registered.source).toBe("catalog");
  expect(registered.provenance).toEqual({ package: "model:catalog-chat", catalogId: "catalog-chat" });
  expect(isModelSelectable(registered)).toBe(false);

  const installed = await installCatalogModel(model, {
    destination: join(fixtureDir, "catalog.gguf"),
    now: () => "2026-09-17T11:01:00.000Z",
    download: async (_url, destination, options) => {
      expect(options.expectedSha256).toBe("b".repeat(64));
      writeFileSync(destination, "gguf");
    },
  });
  expect(installed.verifiedAt).toBe("2026-09-17T11:01:00.000Z");
  expect(isModelSelectable(installed)).toBe(true);
});

test("Hugging Face installation records repo and revision", async () => {
  const installed = await installHuggingFaceModel({
    id: "hf-chat",
    roles: ["chat"],
    repo: "Qwen/Qwen3-8B-GGUF",
    revision: "7c41481f",
    url: "https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/7c41481f/chat.gguf",
    sha256: "c".repeat(64),
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
