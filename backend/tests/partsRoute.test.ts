import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/app";
import { PART_DEFS, partDef } from "@/lib/partDefs";
import { __setComponentDepsForTests, __setComponentUnitsForTests, __settleComponentInstallsForTests, type EnvDef, type UnitDef } from "@/lib/components";
import { listJobs, __resetJobsForTests } from "@/lib/jobs";
import { dataDir } from "@/lib/paths";
import { recordLicenceAcceptance } from "@/lib/licenceAcceptance";
import { LTX_LICENCE_NOTICE } from "@/lib/modelCatalog";
import { StackPartList } from "@maipai/spec/stack/ts/stack-part-list.js";
import type { HardwareInfo } from "@/lib/hardware";
import { __setPartsHardwareForTests, listParts } from "@/lib/partsList";
import { __resetPartChoicesForTests } from "@/lib/partChoices";

const GB = 1_073_741_824;
const hw = (over: Partial<HardwareInfo> = {}): HardwareInfo => ({ platform: "darwin", arch: "arm64", totalRamGb: 128, cpuCount: 16, isAppleSilicon: true, unifiedMemoryGb: 128, cudaDevices: [], freeDiskBytes: 1500 * GB, osVersion: "test", ...over });
const sha = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");
const BYTES = "w".repeat(2048);
const envDir = join(dataDir, "engines", "parts-test", "1");
let envReady = false;
const env: EnvDef = { name: "parts-test", approxBytes: 4096, root: () => envDir, ready: () => envReady && existsSync(join(envDir, "lib.bin")), build: async () => { envReady = true; mkdirSync(envDir, { recursive: true }); writeFileSync(join(envDir, "lib.bin"), "e".repeat(1000)); }, stop: () => {} };
const tinyPin: UnitDef["pins"][number] = { id: "tiny-picture", role: "image", repo: "example/tiny-picture", license: "Apache-2.0", revision: "r1", engine: "mflux", sizing: { profile: "p16" }, download: { url: "https://huggingface.co/example/tiny-picture/resolve/r1/weights.safetensors", sha256: sha(BYTES), approx_bytes: BYTES.length, hub_file: "weights.safetensors" } };
const unit = (): UnitDef => ({ id: "tiny-picture", label: "Tiny picture", summary: "A test picture model.", group: "pictures", role: "image", pins: [tinyPin], envs: [env], usedBy: () => ["Pictures"], busy: () => null });
const fakeDownload = async (_url: string, dest: string, opts: { onProgress?: (p: never) => void }) => { mkdirSync(join(dest, ".."), { recursive: true }); writeFileSync(dest, BYTES); opts.onProgress?.({ completedBytes: BYTES.length, totalBytes: BYTES.length, itemId: "weights.safetensors", itemCompletedBytes: BYTES.length } as never); };

beforeEach(() => { __resetJobsForTests(); __resetPartChoicesForTests(); envReady = false; rmSync(envDir, { recursive: true, force: true }); __setPartsHardwareForTests(null); __setComponentUnitsForTests(null); __setComponentDepsForTests(null); });
afterEach(() => { __resetPartChoicesForTests(); __setPartsHardwareForTests(null); __setComponentUnitsForTests(null); __setComponentDepsForTests(null); rmSync(join(dataDir, "licence-acceptances.json"), { force: true }); });

test("adult and minor routes return the pinned part list shape", async () => {
  for (const audience of ["adult", "minor"]) {
    const response = await app.request(`/stack/v1/parts?audience=${audience}`);
    expect(response.status).toBe(200);
    expect(StackPartList.safeParse(await response.json()).success).toBe(true);
  }
});

test("minor list uses neutral labels and hides adult only parts", async () => {
  const rows = (await listParts({ audience: "minor" })).parts;
  expect(rows.every((row) => row.label === partDef(row.id)?.neutralLabel && row.description === "")).toBe(true);
  expect(rows.some((row) => PART_DEFS.find((def) => def.id === row.id)?.adultOnly)).toBe(false);
  expect(rows.map((row) => row.id)).not.toContain("ltx-2-5-q8-distilled-mlx");
  expect(rows.map((row) => row.id)).not.toContain("minimax-h3");
  expect(rows.map((row) => row.id)).not.toContain("ltx-2-5-bf16-distilled-mlx-max");
  const adultLabels = PART_DEFS.filter((def) => def.kind !== "engine" && def.label.length > 6).map((def) => def.label);
  expect(rows.some((row) => adultLabels.some((label) => row.label.includes(label)))).toBe(false);
});

test("adult hides Wan and minor sees it", async () => {
  const adult = (await listParts({ audience: "adult" })).parts;
  const minor = (await listParts({ audience: "minor" })).parts;
  expect(adult.some((row) => row.id === "fastwan2-2-ti2v-5b-mlx-bf16")).toBe(false);
  expect(minor.some((row) => row.id === "fastwan2-2-ti2v-5b-mlx-bf16")).toBe(true);
  expect(adult.some((row) => `${row.label} ${row.description}`.includes("Wan"))).toBe(false);
});

test("audience lists cover declarations and sort by category, priority and id", async () => {
  const adult = (await listParts({ audience: "adult" })).parts;
  const minor = (await listParts({ audience: "minor" })).parts;
  const adultIds = new Set(adult.map((row) => row.id));
  const minorOnly = PART_DEFS.filter((def) => def.minorOnly).map((def) => def.id);
  expect(new Set([...adultIds, ...minorOnly])).toEqual(new Set(PART_DEFS.map((def) => def.id)));
  const sorted = [...adult].sort((a, b) => a.category.localeCompare(b.category) || a.priority - b.priority || a.id.localeCompare(b.id));
  expect(adult.map((row) => row.id)).toEqual(sorted.map((row) => row.id));
  expect(minor.some((row) => row.id.startsWith("lora."))).toBe(false);
});

test("fits uses profile candidates and unsupported parts carry the component reason", async () => {
  const large = await listParts({ audience: "adult" }, hw());
  expect(large.parts.find((row) => row.id === "z-image-turbo")).toMatchObject({ state: "missing", fits: { max: true } });
  const small = await listParts({ audience: "adult" }, hw({ unifiedMemoryGb: 32, totalRamGb: 32 }));
  expect(small.parts.find((row) => row.id === "z-image-turbo")).toMatchObject({ state: "unsupported", fits: { standard: false, boost: false, max: false, reason: expect.any(String) } });
  expect(small.parts.find((row) => row.id === "image-tools")?.fits).toEqual({ standard: true, boost: true, max: true, reason: null });
});

test("licence_needed follows acceptance", async () => {
  const before = await listParts({ audience: "adult" });
  expect(before.parts.find((row) => row.id === "ltx-2-5-q8-distilled-mlx")?.licence_needed).toBe(true);
  await recordLicenceAcceptance(LTX_LICENCE_NOTICE.id, null);
  expect((await listParts({ audience: "adult" })).parts.find((row) => row.id === "ltx-2-5-q8-distilled-mlx")?.licence_needed).toBe(false);
});

test("install rejects caller supplied pins, joins jobs, installs and uninstalls by id", async () => {
  __setComponentUnitsForTests([unit()]);
  __setComponentDepsForTests({ download: fakeDownload as never });
  const refused = await app.request("/stack/v1/parts/tiny-picture/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://x/y.bin", sha256: "..." }) });
  expect(refused.status).toBe(400); expect(await refused.json()).toMatchObject({ code: "body_not_allowed" });
  expect(listJobs().some((job) => job.kind === "component.install")).toBe(false);
  const scalar = await app.request("/stack/v1/parts/tiny-picture/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify("not an object") });
  expect(scalar.status).toBe(400); expect(await scalar.json()).toMatchObject({ code: "body_not_allowed" });
  const first = await app.request("/stack/v1/parts/tiny-picture/install", { method: "POST" });
  expect(first.status).toBe(202);
  const firstBody = await first.json() as { job: string };
  expect(await (await app.request("/stack/v1/parts/tiny-picture/install", { method: "POST" })).json()).toMatchObject({ job: firstBody.job, joined: true });
  await __settleComponentInstallsForTests();
  expect(await (await app.request("/stack/v1/parts/tiny-picture/install", { method: "POST" })).json()).toMatchObject({ already_installed: true });
  expect(await (await app.request("/stack/v1/parts/tiny-picture", { method: "DELETE" })).json()).toMatchObject({ removed: true });
  expect(await (await app.request("/stack/v1/parts/tiny-picture", { method: "DELETE" })).json()).toMatchObject({ removed: false });
});

test("unknown ids and LoRAs are not parts", async () => {
  for (const [method, path] of [["POST", "/stack/v1/parts/nope/install"], ["DELETE", "/stack/v1/parts/nope"], ["DELETE", "/stack/v1/parts/lora.picture.x"]] as const) expect((await app.request(path, { method })).status).toBe(404);
});

test("filters narrow by kind and category; missing audience is a bad request", async () => {
  const tools = await (await app.request("/stack/v1/parts?audience=adult&kind=tool")).json() as { parts: Array<{ kind: string }> };
  expect(tools.parts.every((part) => part.kind === "tool")).toBe(true);
  const pictures = await (await app.request("/stack/v1/parts?audience=adult&category=pictures")).json() as { parts: Array<{ category: string }> };
  expect(pictures.parts.every((part) => part.category === "pictures")).toBe(true);
  expect((await (await app.request("/stack/v1/parts?audience=adult&category=nothing")).json() as { parts: unknown[] }).parts).toEqual([]);
  expect((await app.request("/stack/v1/parts")).status).toBe(400);
});

test("components route remains available with its existing shape", async () => {
  __setComponentUnitsForTests(null);
  const json = await (await app.request("/stack/v1/components")).json() as { components: Array<Record<string, unknown>> };
  expect(json.components[0]).toHaveProperty("label"); expect(json.components[0]).toHaveProperty("summary"); expect(json.components[0]).toHaveProperty("group"); expect(json.components[0]).toHaveProperty("requirement");
});
