import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "@/app";
import { __resetHealthForTests, list as healthItems } from "@/lib/health";
import { STACK_MODELS, STACK_WAKEWORD_MODELS } from "@/lib/modelCatalog";
import { clearModelsForTests, upsertModel } from "@/lib/modelStore";
import { modelsRoot } from "@/lib/store/layout";
import { writeModelManifest } from "@/lib/store/manifests";

beforeEach(() => { clearModelsForTests(); __resetHealthForTests(); });
afterEach(() => { clearModelsForTests(); __resetHealthForTests(); });

test("wakeword pins are exact, checksummed assets in the shared model catalog", () => {
  expect(STACK_WAKEWORD_MODELS.map((model) => model.id)).toEqual([
    "openwakeword-melspectrogram",
    "openwakeword-embedding",
    "trained-hey-maipai-v2",
  ]);
  for (const pin of STACK_WAKEWORD_MODELS) {
    expect(STACK_MODELS).toContain(pin);
    expect(pin.role).toBe("wakeword");
    expect(pin.component).toBe("wakeword_asset");
    expect(pin.download?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(pin.license).toBeTruthy();
    expect(pin.download?.url).toStartWith("https://github.com/");
  }
  expect(STACK_WAKEWORD_MODELS[0]?.download).toMatchObject({
    url: "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/melspectrogram.onnx",
    sha256: "ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f",
    approx_bytes: 1_087_958,
  });
  expect(STACK_WAKEWORD_MODELS[1]?.download).toMatchObject({
    url: "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/embedding_model.onnx",
    sha256: "70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f",
    approx_bytes: 1_326_578,
  });
  expect(STACK_WAKEWORD_MODELS[2]?.download).toMatchObject({
    url: "https://github.com/getmaipai/bot/releases/download/v0.1.0/trained_hey_maipai_v2.onnx",
    sha256: "6fbff74699801dabf931166badcc51fd655570469fb6d10da1ee5f64b4cba190",
    approx_bytes: 937_243,
  });
});

test("Home can read only installed wakeword assets, with bytes rechecked before serving", async () => {
  const pin = STACK_WAKEWORD_MODELS[0]!;
  const bytes = Buffer.from("verified wakeword test bytes");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const pinnedDigest = pin.download!.sha256;
  pin.download!.sha256 = digest;
  const file = join(modelsRoot, pin.id, "melspectrogram.onnx");
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    upsertModel({ id: pin.id, roles: ["wakeword"], source: "catalog", provenance: { repo: pin.repo }, revision: pin.revision!, sha256: digest, sizeBytes: bytes.byteLength, licence: pin.license!, engineRequirements: { component: pin.component }, verifiedAt: new Date().toISOString(), modelPath: file });
    writeModelManifest({ kind: "model", id: pin.id, source: "catalog", repo: pin.repo, revision: pin.revision, roles: ["wakeword"], blobs: [{ digest, sizeBytes: bytes.byteLength, path: file }], sizeBytes: bytes.byteLength, createdAt: new Date().toISOString() });

    const response = await app.request(`/stack/v1/models/${pin.id}/file`);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("etag")).toBe(`"${digest}"`);

    writeFileSync(file, Buffer.from("tampered"));
    const tampered = await app.request(`/stack/v1/models/${pin.id}/file`);
    expect(tampered.status).toBe(503);
    expect(await tampered.json()).toEqual({ error: "Wakeword asset failed checksum verification" });
    expect(healthItems().some((item) => item.code === "wakeword-asset-checksum-mismatch")).toBe(true);
  } finally {
    pin.download!.sha256 = pinnedDigest;
  }
});

test("the wakeword bytes route refuses other model ids", async () => {
  const response = await app.request("/stack/v1/models/qwen3-1.7b-mlx-4bit/file");
  expect(response.status).toBe(404);
});

test("wakeword installs cannot replace a shipped URL or checksum", async () => {
  const pin = STACK_WAKEWORD_MODELS[0]!;
  const response = await app.request("/stack/v1/models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: pin.id,
      role: pin.role,
      repo: pin.repo,
      url: "https://example.invalid/changed.onnx",
      sha256: "0".repeat(64),
      approx_bytes: pin.download!.approx_bytes,
      licence: pin.license,
      revision: pin.revision,
      component: pin.component,
    }),
  });
  expect(response.status).toBe(400);
});

test("wakeword pins add their GitHub release traffic to the privacy declaration", async () => {
  const response = await app.request("/stack/v1/privacy");
  const body = await response.json() as { rows: Array<{ id: string; hosts: string[]; when: string }> };
  const row = body.rows.find((entry) => entry.id === "wakeword-assets");
  expect(row?.hosts).toContain("github.com");
  expect(row?.when).toContain("model download job");
});
