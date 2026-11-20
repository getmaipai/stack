import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { __sampleDiskForTests, __setDiskReaderForTests, diskAdmission, latestDisk, lowDiskRefusal, missingModelFiles } from "@/lib/diskState";
import { app } from "@/app";
import { modelsDir } from "@/lib/paths";
import { upsertModel, clearModelsForTests } from "@/lib/modelStore";
import { __setPreferredModelForTests } from "@/lib/supervisor";
import { STACK_CHAT_8B_MODEL } from "@/lib/modelCatalog";

const refusal = "There is not enough room left on this computer for that. Free up space in Settings, then try again.";
afterEach(() => __setDiskReaderForTests(null));
afterEach(() => { __setPreferredModelForTests("chat", null); clearModelsForTests(); });

test("disk sampling tracks hysteretic levels and critical admission without reading the real disk", async () => {
  let free = 9_000_000_000;
  __setDiskReaderForTests(() => ({ free, total: 100_000_000_000, device: 1 }));
  await __sampleDiskForTests();
  expect((await latestDisk()).level).toBe("critical");
  expect(await lowDiskRefusal()).toEqual({ kind: "disk", reason: refusal });
  expect(refusal).not.toMatch(/[0-9]|GB/i);
  free = 10_500_000_000;
  await __sampleDiskForTests();
  expect((await latestDisk()).level).toBe("critical");
  free = 12_000_000_000;
  await __sampleDiskForTests();
  expect((await latestDisk()).level).toBe("warn");
  expect((await diskAdmission(3_000_000_000)).ok).toBe(false);
  free = 20_000_000_000;
  await __sampleDiskForTests();
  expect(await diskAdmission(1_000_000_000)).toEqual({ ok: true });
});

test("GET /stack/v1/disk includes volumes and selected-model missing list", async () => {
  const missingPath = `${modelsDir}/${STACK_CHAT_8B_MODEL.id}-route-fixture.gguf`;
  upsertModel({ id: STACK_CHAT_8B_MODEL.id, roles: ["chat"], source: "catalog", provenance: {}, revision: "r", sha256: "b".repeat(64), licence: "MIT", verifiedAt: new Date().toISOString(), modelPath: missingPath });
  __setPreferredModelForTests("chat", STACK_CHAT_8B_MODEL.id);
  __setDiskReaderForTests(() => ({ free: 50_000_000_000, total: 100_000_000_000, device: 9 }));
  const response = await app.request("/stack/v1/disk");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ level: expect.any(String), volumes: [expect.objectContaining({ path: expect.any(String), free_bytes: expect.any(Number), total_bytes: expect.any(Number), warn_bytes: expect.any(Number), critical_bytes: expect.any(Number) })], missing: expect.arrayContaining([expect.objectContaining({ role: "chat", model: STACK_CHAT_8B_MODEL.id, missing_paths: [missingPath] })]) });
  __setPreferredModelForTests("chat", null);
});

test("disk config is accepted at runtime and resets in the test lifecycle", async () => {
  const response = await app.request("/stack/v1/disk/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ warn_free_gb: 40, critical_free_gb: 15 }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, config: { warn_free_gb: 40, critical_free_gb: 15 } });
  __setDiskReaderForTests(null);
});

test("selected model file checks report deleted fixtures and ignore present files", () => {
  const modelId = STACK_CHAT_8B_MODEL.id;
  const path = `${modelsDir}/${modelId}-disk-fixture.gguf`;
  mkdirSync(modelsDir, { recursive: true });
  writeFileSync(path, "x");
  upsertModel({ id: modelId, roles: ["chat"], source: "catalog", provenance: {}, revision: "r", sha256: "a".repeat(64), licence: "MIT", verifiedAt: new Date().toISOString(), modelPath: path });
  __setPreferredModelForTests("chat", modelId);
  expect(missingModelFiles().some((entry) => entry.role === "chat" && entry.model === modelId)).toBe(false);
  rmSync(path);
  expect(missingModelFiles().some((entry) => entry.role === "chat" && entry.model === modelId && entry.missing_paths.includes(path))).toBe(true);
  __setPreferredModelForTests("chat", null);
  clearModelsForTests();
});
