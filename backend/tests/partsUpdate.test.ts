import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { eq } from "drizzle-orm";
import { app } from "@/app";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { __setComponentUnitsForTests, type UnitDef } from "@/lib/components";
import { __resetEventsForTests, eventsAfter } from "@/lib/events";
import { __resetHealthForTests, list as listHealth } from "@/lib/health";
import { __resetJobsForTests, listJobs } from "@/lib/jobs";
import { dataDir, modelsDir } from "@/lib/paths";
import { __setPartsHardwareForTests } from "@/lib/partsList";
import { clearModelsForTests, getModel, upsertModel } from "@/lib/modelStore";
import { stackStatus } from "@/lib/stackStatus";
import { __resetSettingsForTests, updateSettings } from "@/settings";
import { MODEL_INDEX_URL, ENGINE_INDEX_URL, __resetUpdatesForTests, checkCatalog } from "@/updates/catalog";
import type { HardwareInfo } from "@/lib/hardware";
import { __setModelUpdateDownloadForTests, __settleModelUpdatesForTests } from "@/updates/models";

const id = "z-image-turbo";
const oldBytes = "old fixture weights";
const newBytes = "new fixture weights";
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const hw: HardwareInfo = { platform: "darwin", arch: "arm64", totalRamGb: 128, cpuCount: 16, isAppleSilicon: true, unifiedMemoryGb: 128, cudaDevices: [], freeDiskBytes: 1500_000_000_000, osVersion: "test" };
let download: (url: string, dest: string) => Promise<void>;
const oldPath = join(modelsDir, id, "old", "weights.gguf");
const oldRecord = () => upsertModel({ id, roles: ["image"], source: "catalog", provenance: { catalogId: id }, revision: "old-revision", sha256: sha(oldBytes), sizeBytes: oldBytes.length, licence: "Apache-2.0", modelPath: oldPath, installedAt: "2026-01-01T00:00:00.000Z", verifiedAt: "2026-01-01T00:00:00.000Z" });
const unit = (): UnitDef => ({ id, label: "Z Image Turbo", summary: "Fixture model", group: "pictures", role: "image", pins: [{ id, role: "image", repo: "example/z-image", license: "Apache-2.0", revision: "old-revision", engine: "mflux", sizing: { profile: "p16" }, download: { url: "https://huggingface.co/example/z-image/resolve/old-revision/weights.gguf", sha256: sha(oldBytes), approx_bytes: oldBytes.length, hub_file: "weights.gguf" } }], envs: [], usedBy: () => [], busy: () => null });
const entry = { id, role: "image", profile: "p16", quality: 1, repo: "example/z-image", license: "Apache-2.0", revision: "newer-revision", engine: "mflux", download: { url: "https://huggingface.co/example/z-image/resolve/newer-revision/weights.gguf", sha256: sha(newBytes), approx_bytes: newBytes.length } };
function response(body: unknown, status = 200) { return new Response(status === 304 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
async function check(withEntry = true) {
  updateSettings({ "stack.updates.enabled": true });
  await checkCatalog(async (input) => String(input) === MODEL_INDEX_URL ? response({ version: "1", models: withEntry ? [entry] : [] }) : String(input) === ENGINE_INDEX_URL ? response({ version: "1", engines: [] }) : response({}, 500));
}
function previous() { return db.select({ value: meta.value }).from(meta).where(eq(meta.key, `parts.${id}.previous`)).get()?.value; }

beforeEach(() => {
  __resetJobsForTests(); __resetEventsForTests(); __resetHealthForTests(); __resetUpdatesForTests(); __resetSettingsForTests(); clearModelsForTests();
  __setPartsHardwareForTests(hw); __setComponentUnitsForTests([unit()]);
  rmSync(join(modelsDir, id), { recursive: true, force: true }); mkdirSync(join(oldPath, ".."), { recursive: true }); writeFileSync(oldPath, oldBytes); oldRecord();
  download = async (_url, dest) => { mkdirSync(join(dest, ".."), { recursive: true }); writeFileSync(dest, newBytes); };
  __setModelUpdateDownloadForTests((url, dest) => download(url, dest));
});
afterEach(async () => { await __settleModelUpdatesForTests(); __setModelUpdateDownloadForTests(null); __setPartsHardwareForTests(null); __setComponentUnitsForTests(null); clearModelsForTests(); __resetUpdatesForTests(); __resetHealthForTests(); rmSync(join(modelsDir, id), { recursive: true, force: true }); rmSync(join(dataDir, "licence-acceptances.json"), { force: true }); });

test("part update flag reflects the index only for ready models", async () => {
  await check();
  const ready = (await (await app.request("/stack/v1/parts?audience=adult")).json() as { parts: Array<{ id: string; update: unknown }> }).parts.find((part) => part.id === id);
  expect(ready?.update).toEqual({ available: true, version: "newer-revision" });
  await check(false);
  const absent = (await (await app.request("/stack/v1/parts?audience=adult")).json() as { parts: Array<{ id: string; update: unknown }> }).parts.find((part) => part.id === id);
  expect(absent?.update).toEqual({ available: false, version: null });
  clearModelsForTests();
  await check();
  const missing = (await (await app.request("/stack/v1/parts?audience=adult")).json() as { parts: Array<{ id: string; state: string; update: unknown }> }).parts.find((part) => part.id === id);
  expect(missing).toMatchObject({ state: "missing", update: { available: false, version: null } });
});

test("model update stages to a new revision and keeps one previous file for rollback", async () => {
  await check();
  const response = await app.request(`/stack/v1/parts/${id}/update`, { method: "POST" });
  expect(response.status).toBe(202);
  const { job } = await response.json() as { job: string };
  while (listJobs().find((row) => row.id === job)?.state === "running") await new Promise((resolve) => setTimeout(resolve, 1));
  const updated = getModel(id)!;
  expect(updated.revision).toBe("newer-revision"); expect(updated.modelPath).toContain("newer-revision");
  expect(JSON.parse(previous()!).revision).toBe("old-revision"); expect(existsSync(oldPath)).toBe(true);
  expect(eventsAfter(0).filter((event) => event.id === "update.applied")).toHaveLength(1);
  expect(listHealth()).toEqual([]);
  expect((await (await app.request("/stack/v1/parts?audience=adult")).json() as { parts: Array<{ id: string; update: unknown }> }).parts.find((row) => row.id === id)?.update).toEqual({ available: false, version: null });
});

test("failed model update restores its record and offers one retry health item", async () => {
  await check(); const before = getModel(id)!;
  download = async () => { throw new Error("fixture download failed"); }; __setModelUpdateDownloadForTests((url, dest) => download(url, dest));
  const response = await app.request(`/stack/v1/parts/${id}/update`, { method: "POST" }); const body = await response.json() as { job: string };
  while (listJobs().find((row) => row.id === body.job)?.state === "running") await new Promise((resolve) => setTimeout(resolve, 1));
  expect(getModel(id)).toMatchObject({ revision: before.revision, modelPath: before.modelPath, sha256: before.sha256 });
  expect(existsSync(join(modelsDir, id, "newer-revision", "weights.gguf"))).toBe(false);
  expect(listHealth()).toMatchObject([{ code: `update-failed.${id}`, fix: { label: "Try again" } }]);
  expect((await stackStatus(hw)).problems).toMatchObject([{ code: `update-failed.${id}`, part_id: id }]);
  download = async (_url, dest) => { mkdirSync(join(dest, ".."), { recursive: true }); writeFileSync(dest, newBytes); }; __setModelUpdateDownloadForTests((url, dest) => download(url, dest));
  const retry = await app.request(`/stack/v1/parts/${id}/update`, { method: "POST" }); const retryBody = await retry.json() as { job: string };
  while (listJobs().find((row) => row.id === retryBody.job)?.state === "running") await new Promise((resolve) => setTimeout(resolve, 1));
  expect(listHealth()).toEqual([]);
});

test("model rollback restores the previous revision and is single use", async () => {
  await check(); const first = await app.request(`/stack/v1/parts/${id}/update`, { method: "POST" }); const job = (await first.json() as { job: string }).job;
  while (listJobs().find((row) => row.id === job)?.state === "running") await new Promise((resolve) => setTimeout(resolve, 1));
  const rollback = await app.request(`/stack/v1/parts/${id}/rollback`, { method: "POST" }); expect(rollback.status).toBe(200); expect(getModel(id)).toMatchObject({ revision: "old-revision", modelPath: oldPath }); expect(previous()).toBeUndefined();
  expect(await (await app.request(`/stack/v1/parts/${id}/rollback`, { method: "POST" })).json()).toMatchObject({ code: "no_previous" });
});

test("updating appears on the part row and Stack status while download is held", async () => {
  await check(); let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
  download = async (_url, dest) => { await blocked; mkdirSync(join(dest, ".."), { recursive: true }); writeFileSync(dest, newBytes); };
  await app.request(`/stack/v1/parts/${id}/update`, { method: "POST" });
  const row = (await (await app.request("/stack/v1/parts?audience=adult")).json() as { parts: Array<{ id: string; state: string }> }).parts.find((part) => part.id === id);
  expect(row?.state).toBe("updating"); expect((await stackStatus(hw)).health).toBe("updating"); release();
});

test("only a pending llama engine or an available model has an update; caller pins are rejected", async () => {
  await check(false);
  for (const part of ["llama-server", "image-tools"]) { const response = await app.request(`/stack/v1/parts/${part}/update`, { method: "POST" }); expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "no_update" }); }
  const bad = await app.request(`/stack/v1/parts/${id}/update`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "x" }) }); expect(bad.status).toBe(400); expect(await bad.json()).toMatchObject({ code: "body_not_allowed" });
});
