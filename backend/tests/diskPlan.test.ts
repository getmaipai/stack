import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDiskPlan, diskPlanExport, diskTotalsFor } from "@/lib/diskPlan";
import { plannedPinsFor } from "@/lib/installPlan";
import { STACK_MODELS, STACK_VIDEO_MODELS, STACK_IMAGE_KLEIN_MODELS, STACK_IMAGE_ZIMAGE_MODELS } from "@/lib/modelCatalog";
import measured from "@/lib/diskPlanMeasured.json";
import { PROFILE_TIERS } from "@/profiles";
import { app } from "@/app";

const GB = 1_073_741_824;
const pinBytes = (id: string) => STACK_MODELS.find((pin) => pin.id === id)!.download!.approx_bytes;
const table = measured as unknown as { margin_percent: number; pins: Record<string, { download_bytes: number; installed_bytes: number }>; engines: Record<string, { installed_bytes: number; download_bytes: number; peak_temp_bytes: number }> };

test("drift: every pin's bytes match the measured table (run bun run measure:disk-plan after a pin changes)", () => {
  const drifted = STACK_MODELS.filter((pin) => table.pins[pin.id]?.download_bytes !== pin.download?.approx_bytes).map((pin) => pin.id);
  expect(drifted).toEqual([]);
  const stale = Object.keys(table.pins).filter((id) => !STACK_MODELS.some((pin) => pin.id === id));
  expect(stale).toEqual([]);
});

test("an archive is bigger on disk than its download; every other pin is stored byte for byte", () => {
  for (const pin of STACK_MODELS) {
    const row = table.pins[pin.id]!;
    if (pin.download?.archive) expect(row.installed_bytes).toBeGreaterThanOrEqual(row.download_bytes);
    else expect(row.installed_bytes).toBe(row.download_bytes);
  }
});

test("every model the install plan installs belongs to exactly one row, in every tier", () => {
  for (const tier of PROFILE_TIERS) {
    const plan = buildDiskPlan(tier);
    const counts = new Map<string, number>();
    for (const row of plan.rows) for (const id of row.model_ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const { pin } of plannedPinsFor(tier)) expect([tier.id, pin.id, counts.get(pin.id)]).toEqual([tier.id, pin.id, 1]);
    for (const [id, count] of counts) expect([tier.id, id, count]).toEqual([tier.id, id, 1]);
  }
});

test("sums: each tier's default total is its pins plus Home plus the engines they need, and the margin is 20 percent of the installed part plus the temp space", () => {
  for (const tier of PROFILE_TIERS) {
    const plan = buildDiskPlan(tier);
    const ids = plan.default_selected;
    const rows = plan.rows.filter((row) => ids.includes(row.id));
    const engines = new Set(rows.flatMap((row) => row.engines));
    const engineRows = plan.rows.filter((row) => engines.has(row.id));
    const installed = [...rows, ...engineRows].reduce((sum, row) => sum + row.installed_bytes, 0);
    const temp = [...rows, ...engineRows].reduce((sum, row) => sum + row.peak_temp_bytes, 0);
    expect(plan.default.installed_bytes).toBe(installed);
    expect(plan.default.peak_temp_bytes).toBe(temp);
    expect(plan.default.required_free_bytes).toBe(Math.ceil(installed * 1.2) + temp);
    expect(diskTotalsFor(plan, ids)).toEqual(plan.default);
    // The pins add up to the rows' download sizes.
    const modelDownload = rows.filter((row) => row.kind === "model").reduce((sum, row) => sum + row.model_ids.reduce((s, id) => s + pinBytes(id), 0), 0);
    expect(rows.filter((row) => row.model_ids.length).reduce((sum, row) => sum + row.download_bytes, 0)).toBe(modelDownload);
    expect(plan.minimum.required_free_bytes).toBeLessThanOrEqual(plan.default.required_free_bytes);
    expect(plan.default.required_free_bytes).toBeLessThanOrEqual(plan.everything.required_free_bytes);
  }
});

test("home and AI parts add up to the whole within a byte per part", () => {
  for (const tier of PROFILE_TIERS) {
    const plan = buildDiskPlan(tier);
    const home = diskTotalsFor(plan, plan.default_selected, "home");
    const ai = diskTotalsFor(plan, plan.default_selected, "ai");
    expect(home.installed_bytes + ai.installed_bytes).toBe(plan.default.installed_bytes);
    expect(home.peak_temp_bytes + ai.peak_temp_bytes).toBe(plan.default.peak_temp_bytes);
    expect(Math.abs(home.required_free_bytes + ai.required_free_bytes - plan.default.required_free_bytes)).toBeLessThanOrEqual(2);
    expect(home.installed_bytes).toBe(buildDiskPlan(tier).rows.find((row) => row.id === "home")!.installed_bytes);
  }
});

test("tiers: p16 and p32 have no generators, p64 has pictures but no video, p128 has Z-Image as a recommended default and video as an optional extra", () => {
  const ids = (tier: string) => buildDiskPlan(PROFILE_TIERS.find((t) => t.id === tier)!).rows.map((row) => row.id);
  for (const tier of ["p16", "p32"]) for (const id of ["pictures", "pictures-zimage", "video", "voice-better"]) expect(ids(tier)).not.toContain(id);
  expect(ids("p64")).toContain("pictures");
  expect(ids("p64")).toContain("voice-better");
  for (const id of ["pictures-zimage", "video"]) expect(ids("p64")).not.toContain(id);
  const p128 = buildDiskPlan(PROFILE_TIERS.find((t) => t.id === "p128")!);
  { const row = p128.rows.find((r) => r.id === "video")!; expect(row.need).toBe("optional"); expect(p128.default_selected).not.toContain("video"); }
  // Owner ruling 2026-10-17: Z-Image-Turbo is the main picture maker on a 128 GB computer, so it installs by default; Klein stays for quick pictures and every edit.
  { const row = p128.rows.find((r) => r.id === "pictures-zimage")!; expect(row.need).toBe("recommended"); expect(p128.default_selected).toContain("pictures-zimage"); expect(row.label).toBe("Make pictures (Z-Image Turbo)"); }
  expect(p128.rows.find((r) => r.id === "pictures")!.label).toBe("Quick pictures and edits (FLUX.2 Klein)");
  expect(buildDiskPlan(PROFILE_TIERS.find((t) => t.id === "p64")!).rows.find((r) => r.id === "pictures")!.label).toBe("Make pictures (FLUX.2 Klein)");
  expect(p128.rows.find((r) => r.id === "pictures")!.need).toBe("recommended");
  expect(p128.rows.find((r) => r.id === "video")!.download_bytes).toBe(STACK_VIDEO_MODELS.reduce((s, p) => s + p.download!.approx_bytes, 0));
  expect(p128.rows.find((r) => r.id === "pictures")!.download_bytes).toBe(STACK_IMAGE_KLEIN_MODELS.reduce((s, p) => s + p.download!.approx_bytes, 0));
  expect(p128.rows.find((r) => r.id === "pictures-zimage")!.download_bytes).toBe(STACK_IMAGE_ZIMAGE_MODELS.reduce((s, p) => s + p.download!.approx_bytes, 0));
  // The sizes the owner quoted, to the gigabyte: Klein about 16, Z-Image about 33, video about 24 (23 on disk by du -h).
  expect(Math.round(p128.rows.find((r) => r.id === "pictures")!.installed_bytes / GB)).toBe(15);
  expect(Math.round(p128.rows.find((r) => r.id === "pictures-zimage")!.installed_bytes / GB)).toBe(31);
});

test("turning an optional row on or off moves the total by that row and its engine, and a shared engine is counted once", () => {
  const plan = buildDiskPlan(PROFILE_TIERS.find((t) => t.id === "p128")!);
  const base = diskTotalsFor(plan, plan.default_selected);
  const video = plan.rows.find((r) => r.id === "video")!;
  const videoEngine = plan.rows.find((r) => r.id === "engine:video")!;
  const withVideo = diskTotalsFor(plan, [...plan.default_selected, "video"]);
  expect(withVideo.installed_bytes - base.installed_bytes).toBe(video.installed_bytes + videoEngine.installed_bytes);
  const zimage = plan.rows.find((r) => r.id === "pictures-zimage")!;
  const withoutZ = diskTotalsFor(plan, plan.default_selected.filter((id) => id !== "pictures-zimage"));
  expect(base.installed_bytes - withoutZ.installed_bytes).toBe(zimage.installed_bytes); // the picture engine is already counted for Klein
  const klein = plan.rows.find((r) => r.id === "pictures")!;
  const noKlein = diskTotalsFor(plan, plan.default_selected.filter((id) => id !== "pictures"));
  expect(base.installed_bytes - noKlein.installed_bytes).toBe(klein.installed_bytes); // Z-Image-Turbo still needs the picture engine
  const noPictures = diskTotalsFor(plan, plan.default_selected.filter((id) => id !== "pictures" && id !== "pictures-zimage"));
  expect(base.installed_bytes - noPictures.installed_bytes).toBe(klein.installed_bytes + zimage.installed_bytes + plan.rows.find((r) => r.id === "engine:pictures")!.installed_bytes);
});

test("rows already on this computer are marked installed", () => {
  const tier = PROFILE_TIERS.find((t) => t.id === "p64")!;
  const ids = plannedPinsFor(tier).map((entry) => entry.pin.id);
  const plan = buildDiskPlan(tier, ids);
  expect(plan.rows.find((r) => r.id === "chat")!.installed).toBe(true);
  expect(plan.rows.find((r) => r.id === "pictures")!.installed).toBe(false);
});

test("the shipped export (docs/disk-plan.json) matches the code: bun run gen:disk-plan", () => {
  const onDisk = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "docs", "disk-plan.json"), "utf8"));
  expect(onDisk).toEqual(JSON.parse(JSON.stringify(diskPlanExport())));
  expect(table.margin_percent).toBe(20);
});

test("route: the install plan carries the disk plan for its tier", async () => {
  const body = await (await app.request("/stack/v1/install-plan")).json() as { tier: string | null; disk: { tier: string; rows: Array<{ id: string }>; default: { required_free_bytes: number } } | null };
  expect(body.tier).not.toBeNull();
  expect(body.disk?.tier).toBe(body.tier!);
  expect(body.disk?.rows.map((row) => row.id)).toContain("chat");
  expect(body.disk!.default.required_free_bytes).toBeGreaterThan(10 * GB);
  // Every picture and video row's pins are offered as pull bodies, none of them in the first-run models.
  const full = body as unknown as { models: Array<{ id: string }>; optional_models: Array<{ id: string }>; disk: { rows: Array<{ id: string; model_ids: string[] }> } };
  for (const id of ["pictures", "pictures-zimage", "video"]) {
    const row = full.disk.rows.find((candidate) => candidate.id === id);
    if (!row) continue;
    expect(full.optional_models.map((m) => m.id).sort()).toEqual(expect.arrayContaining(row.model_ids.slice().sort()));
    for (const modelId of row.model_ids) expect(full.models.map((m) => m.id)).not.toContain(modelId);
  }
});
