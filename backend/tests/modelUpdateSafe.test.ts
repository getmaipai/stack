import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { __setComponentUnitsForTests, type UnitDef } from "@/lib/components";
import { __resetHealthForTests } from "@/lib/health";
import { list as listHealth } from "@/lib/health";
import { __resetJobsForTests } from "@/lib/jobs";
import { modelsDir } from "@/lib/paths";
import { __setPartsHardwareForTests } from "@/lib/partsList";
import { clearModelsForTests, getModel, upsertModel } from "@/lib/modelStore";
import { __resetSettingsForTests, updateSettings } from "@/settings";
import { MODEL_INDEX_URL, ENGINE_INDEX_URL, __resetUpdatesForTests, checkCatalog } from "@/updates/catalog";
import type { HardwareInfo } from "@/lib/hardware";
import { __crashModelUpdateAfterForTests, __setModelLoadCheckForTests, applyModelUpdate, previousModel, recoverModelUpdates } from "@/updates/models";

const id = "z-image-turbo";
const oldBytes = "old fixture weights";
const newBytes = "new fixture weights";
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const hw: HardwareInfo = { platform: "darwin", arch: "arm64", totalRamGb: 128, cpuCount: 16, isAppleSilicon: true, unifiedMemoryGb: 128, cudaDevices: [], freeDiskBytes: 1500_000_000_000, osVersion: "test" };
const oldPath = join(modelsDir, id, "old", "weights.gguf");
const newPath = join(modelsDir, id, "newer-revision", "weights.gguf");
const unit = (): UnitDef => ({ id, label: "Z Image Turbo", summary: "Fixture model", group: "pictures", role: "image", pins: [{ id, role: "image", repo: "example/z-image", license: "Apache-2.0", revision: "old-revision", engine: "mflux", sizing: { profile: "p16" }, download: { url: "https://huggingface.co/example/z-image/resolve/old-revision/weights.gguf", sha256: sha(oldBytes), approx_bytes: oldBytes.length, hub_file: "weights.gguf" } }], envs: [], usedBy: () => [], busy: () => null });
const entry = { id, role: "image", profile: "p16", quality: 1, repo: "example/z-image", license: "Apache-2.0", revision: "newer-revision", engine: "mflux", download: { url: "https://huggingface.co/example/z-image/resolve/newer-revision/weights.gguf", sha256: sha(newBytes), approx_bytes: newBytes.length } };
const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const write = (bytes: string) => async (_url: string, dest: string) => { mkdirSync(join(dest, ".."), { recursive: true }); writeFileSync(dest, bytes); };
const journals = () => db.select().from(meta).all().filter((row) => row.key.endsWith(".journal"));
const writeJournal = (keyId: string, value: string) => db.insert(meta).values({ key: `updates.model.${keyId}.journal`, value }).run();

beforeEach(async () => {
  __resetJobsForTests(); __resetHealthForTests(); __resetUpdatesForTests(); __resetSettingsForTests(); clearModelsForTests();
  __setPartsHardwareForTests(hw); __setComponentUnitsForTests([unit()]);
  rmSync(join(modelsDir, id), { recursive: true, force: true }); mkdirSync(join(oldPath, ".."), { recursive: true }); writeFileSync(oldPath, oldBytes);
  upsertModel({ id, roles: ["image"], source: "catalog", provenance: { catalogId: id }, revision: "old-revision", sha256: sha(oldBytes), sizeBytes: oldBytes.length, licence: "Apache-2.0", modelPath: oldPath, installedAt: "2026-01-01T00:00:00.000Z", verifiedAt: "2026-01-01T00:00:00.000Z" });
  updateSettings({ "stack.updates.enabled": true });
  await checkCatalog(async (input) => String(input) === MODEL_INDEX_URL ? respond({ version: "1", models: [entry] }) : String(input) === ENGINE_INDEX_URL ? respond({ version: "1", engines: [] }) : respond({}));
  __setModelLoadCheckForTests(async () => {});
});
afterEach(() => { __crashModelUpdateAfterForTests(null); __setModelLoadCheckForTests(null); __setPartsHardwareForTests(null); __setComponentUnitsForTests(null); clearModelsForTests(); __resetUpdatesForTests(); __resetHealthForTests(); rmSync(join(modelsDir, id), { recursive: true, force: true }); });

test("a passing load check commits the new model, keeps the old files as previous and clears the journal", async () => {
  const result = await applyModelUpdate(id, { download: write(newBytes) });
  expect(result).toMatchObject({ applied: true, revision: "newer-revision" });
  expect(getModel(id)?.revision).toBe("newer-revision");
  expect(previousModel(id)?.modelPath).toBe(oldPath);
  expect(existsSync(oldPath)).toBe(true);
  expect(journals()).toHaveLength(0);
});

test("a new model that fails to load is refused: the old record, the old file and no leftovers", async () => {
  __setModelLoadCheckForTests(async () => { throw new Error("The new model did not load."); });
  const result = await applyModelUpdate(id, { download: write(newBytes) });
  expect(result).toMatchObject({ applied: false });
  expect(getModel(id)?.revision).toBe("old-revision");
  expect(getModel(id)?.modelPath).toBe(oldPath);
  expect(existsSync(oldPath)).toBe(true);
  expect(existsSync(newPath)).toBe(false);
  expect(journals()).toHaveLength(0);
});

test("a corrupt new file is refused with the old model still the record", async () => {
  const result = await applyModelUpdate(id, { download: write("corrupt bytes") });
  expect(result).toMatchObject({ applied: false });
  expect(getModel(id)?.revision).toBe("old-revision");
  expect(existsSync(oldPath)).toBe(true);
  expect(existsSync(newPath)).toBe(false);
  expect(journals()).toHaveLength(0);
});

for (const phase of ["staging", "loading"] as const) {
  test(`a crash after the ${phase} step boots on the old model and removes the new files`, async () => {
    __crashModelUpdateAfterForTests(phase);
    await expect(applyModelUpdate(id, { download: write(newBytes) })).rejects.toThrow(/crash/);
    expect(journals()).toHaveLength(1);
    // The Stack is "killed" here; the next boot runs the recovery.
    expect(recoverModelUpdates()).toEqual([{ id, action: "undone" }]);
    expect(getModel(id)?.revision).toBe("old-revision");
    expect(getModel(id)?.modelPath).toBe(oldPath);
    expect(existsSync(oldPath)).toBe(true);
    expect(existsSync(newPath)).toBe(false);
    expect(journals()).toHaveLength(0);
  });
}

test("a crash after the load check passed finishes the update at the next boot", async () => {
  __crashModelUpdateAfterForTests("committed");
  await expect(applyModelUpdate(id, { download: write(newBytes) })).rejects.toThrow(/crash/);
  expect(recoverModelUpdates()).toEqual([{ id, action: "finished" }]);
  expect(getModel(id)?.revision).toBe("newer-revision");
  expect(previousModel(id)?.modelPath).toBe(oldPath);
  expect(journals()).toHaveLength(0);
});

test("recovery retains and reports malformed or incomplete journals", () => {
  const incomplete = [
    `updates.model.bad-json.journal`,
    `updates.model.missing-id.journal`,
    `updates.model.missing-phase.journal`,
    `updates.model.missing-destination.journal`,
    `updates.model.missing-snapshot.journal`,
  ];
  const snapshotFor = (keyId: string) => ({ ...getModel(id)!, id: keyId });
  writeJournal("bad-json", "{");
  writeJournal("missing-id", JSON.stringify({ phase: "staging", revision: "r", destination: newPath, snapshot: snapshotFor("missing-id") }));
  writeJournal("missing-phase", JSON.stringify({ id: "missing-phase", revision: "r", destination: newPath, snapshot: snapshotFor("missing-phase") }));
  writeJournal("missing-destination", JSON.stringify({ id: "missing-destination", phase: "staging", revision: "r", snapshot: snapshotFor("missing-destination") }));
  writeJournal("missing-snapshot", JSON.stringify({ id: "missing-snapshot", phase: "staging", revision: "r", destination: newPath }));

  const recovered = recoverModelUpdates();
  expect(recovered).toHaveLength(0);
  expect(journals().map((row) => row.key).sort()).toEqual(incomplete.sort());
  expect(listHealth().find((item) => item.code === "model-update-recovery")?.text).toContain("5 model update journals");
  expect(listHealth().find((item) => item.code === "model-update-recovery")?.text).not.toMatch(/bad-json|missing-id|missing-phase|missing-destination|missing-snapshot|\.gguf/);
});

test("a recovery step that throws retains and reports its journal", () => {
  writeJournal(id, JSON.stringify({ id, phase: "staging", revision: "newer-revision", destination: newPath, snapshot: getModel(id) }));
  const remove = spyOn(fs, "rmSync").mockImplementation(() => { throw new Error("fixture cleanup failure"); });
  const result = recoverModelUpdates();
  remove.mockRestore();
  expect(result).toHaveLength(0);
  expect(journals()).toHaveLength(1);
  expect(listHealth().find((item) => item.code === "model-update-recovery")?.text).toContain("1 model update journal");
});
