import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDiskPlan, diskPlanExport, diskTotalsFor } from "@/lib/diskPlan";
import { plannedPinsFor } from "@/lib/installPlan";
import { STACK_MODELS, STACK_VIDEO_MODELS, STACK_IMAGE_KLEIN_MODELS, STACK_IMAGE_ERNIE_MODELS, STACK_IMAGE_ZIMAGE_MODELS } from "@/lib/modelCatalog";
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

test("tiers: p16 and p32 have no generators, p64 has Klein and ERNIE, p128 adds Z-Image and Quick video; Detailed video is an optional extra", () => {
  const ids = (tier: string) => buildDiskPlan(PROFILE_TIERS.find((t) => t.id === tier)!).rows.map((row) => row.id);
  for (const tier of ["p16", "p32"]) for (const id of ["pictures", "pictures-ernie", "pictures-zimage", "video", "voice-better"]) expect(ids(tier)).not.toContain(id);
  expect(ids("p64")).toContain("pictures");
  expect(ids("p64")).toContain("pictures-ernie");
  expect(ids("p64")).toContain("voice-better");
  for (const id of ["pictures-zimage", "video", "video-detailed"]) expect(ids("p64")).not.toContain(id);
  const p128 = buildDiskPlan(PROFILE_TIERS.find((t) => t.id === "p128")!);
  for (const id of ["pictures-zimage", "video-detailed"]) { const row = p128.rows.find((r) => r.id === id)!; expect(row.need).toBe("optional"); expect(p128.default_selected).not.toContain(id); }
  expect(p128.rows.find((r) => r.id === "pictures")!.need).toBe("required");
  for (const tier of ["p64", "p128"]) {
    const plan = buildDiskPlan(PROFILE_TIERS.find((candidate) => candidate.id === tier)!);
    const klein = plan.rows.find((row) => row.id === "pictures")!;
    const ernie = plan.rows.find((row) => row.id === "pictures-ernie")!;
    expect(klein).toMatchObject({ label: "Change pictures (FLUX.2 Klein)", note: "Needed. Edits the pictures you already have, and makes new ones when ERNIE is not installed.", need: "required" });
    expect(ernie).toMatchObject({ label: "Make pictures (ERNIE)", note: "Recommended. Draws words in pictures correctly. Makes new pictures from a sentence.", need: "recommended" });
    expect(plan.default_selected).toContain("pictures");
    expect(plan.default_selected).toContain("pictures-ernie");
    expect(ernie.download_bytes).toBe(STACK_IMAGE_ERNIE_MODELS.reduce((sum, pin) => sum + pin.download!.approx_bytes, 0));
  }
  expect(p128.rows.find((r) => r.id === "video")!.download_bytes).toBe(STACK_VIDEO_MODELS.reduce((s, p) => s + p.download!.approx_bytes, 0));
  expect(p128.rows.find((r) => r.id === "pictures")!.download_bytes).toBe(STACK_IMAGE_KLEIN_MODELS.reduce((s, p) => s + p.download!.approx_bytes, 0));
  expect(p128.rows.find((r) => r.id === "pictures-zimage")!.download_bytes).toBe(STACK_IMAGE_ZIMAGE_MODELS.reduce((s, p) => s + p.download!.approx_bytes, 0));
  // The sizes the owner quoted, to the gigabyte: Klein about 16, ERNIE about 24, Z-Image about 33.
  expect(Math.round(p128.rows.find((r) => r.id === "pictures")!.installed_bytes / GB)).toBe(15);
  expect(Math.round(p128.rows.find((r) => r.id === "pictures-ernie")!.installed_bytes / 1_000_000_000)).toBe(24);
  expect(Math.round(p128.rows.find((r) => r.id === "pictures-zimage")!.installed_bytes / GB)).toBe(31);
});

test("turning an optional row on or off moves the total by that row and its engine, and a shared engine is counted once", () => {
  const plan = buildDiskPlan(PROFILE_TIERS.find((t) => t.id === "p128")!);
  const base = diskTotalsFor(plan, plan.default_selected);
  const video = plan.rows.find((r) => r.id === "video")!;
  const videoEngine = plan.rows.find((r) => r.id === "engine:video")!;
  const detailed = plan.rows.find((r) => r.id === "video-detailed")!;
  // Quick video is on by default and brings the video engine, so Detailed video adds only its own weights.
  expect(plan.default_selected).toContain("video");
  const withDetailed = diskTotalsFor(plan, [...plan.default_selected, "video-detailed"]);
  expect(withDetailed.installed_bytes - base.installed_bytes).toBe(detailed.installed_bytes);
  const noVideo = diskTotalsFor(plan, plan.default_selected.filter((id) => id !== "video"));
  const withBoth = diskTotalsFor(plan, [...plan.default_selected.filter((id) => id !== "video"), "video-detailed"]);
  expect(withBoth.installed_bytes - noVideo.installed_bytes).toBe(detailed.installed_bytes + videoEngine.installed_bytes);
  const zimage = plan.rows.find((r) => r.id === "pictures-zimage")!;
  const withZ = diskTotalsFor(plan, [...plan.default_selected, "pictures-zimage"]);
  expect(withZ.installed_bytes - base.installed_bytes).toBe(zimage.installed_bytes); // the picture engine is already counted for Klein
  const ernie = plan.rows.find((r) => r.id === "pictures-ernie")!;
  const withoutErnie = diskTotalsFor(plan, plan.default_selected.filter((id) => id !== "pictures-ernie"));
  expect(base.installed_bytes - withoutErnie.installed_bytes).toBe(ernie.installed_bytes);
  const noPictures = diskTotalsFor(plan, plan.default_selected.filter((id) => id !== "pictures"));
  const klein = plan.rows.find((r) => r.id === "pictures")!;
  // ERNIE remains selected, so the shared picture engine stays counted when Klein is removed.
  expect(base.installed_bytes - noPictures.installed_bytes).toBe(klein.installed_bytes);
});

test("rows already on this computer are marked installed", () => {
  const tier = PROFILE_TIERS.find((t) => t.id === "p64")!;
  const ids = plannedPinsFor(tier).map((entry) => entry.pin.id);
  const plan = buildDiskPlan(tier, ids);
  expect(plan.rows.find((r) => r.id === "chat")!.installed).toBe(true);
  // Klein is in the first-run plan on p64 (a required row), ERNIE is not.
  expect(plan.rows.find((r) => r.id === "pictures")!.installed).toBe(true);
  expect(plan.rows.find((r) => r.id === "pictures-ernie")!.installed).toBe(false);
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
  const full = body as unknown as { models: Array<{ id: string }>; optional_models: Array<{ id: string }>; disk: { rows: Array<{ id: string; model_ids: string[] }> } };
  // Every picture and video row's pins are offered as pull bodies.
  for (const id of ["pictures", "pictures-ernie", "pictures-zimage", "video"]) {
    const row = full.disk.rows.find((candidate) => candidate.id === id);
    if (!row) continue;
    expect(full.optional_models.map((m) => m.id).sort()).toEqual(expect.arrayContaining(row.model_ids.slice().sort()));
  }
  // Klein is required, so its pins are in the first-run models on a tier that has image; the other generator rows are not.
  const klein = full.disk.rows.find((candidate) => candidate.id === "pictures");
  if (klein) for (const modelId of klein.model_ids) expect(full.models.map((m) => m.id)).toContain(modelId);
  for (const id of ["pictures-ernie", "pictures-zimage", "video"]) {
    const row = full.disk.rows.find((candidate) => candidate.id === id);
    if (!row) continue;
    for (const modelId of row.model_ids) expect(full.models.map((m) => m.id)).not.toContain(modelId);
  }
});

test("oMLX is an optional row on p64 and p128 only, off by default, and its 19 GB is not in the default totals (ENGINE-MLX-02)", () => {
  for (const tier of PROFILE_TIERS) {
    const plan = buildDiskPlan(tier);
    const row = plan.rows.find((candidate) => candidate.id === "chat-mlx");
    if (tier.id === "p64" || tier.id === "p128") {
      expect(row).toMatchObject({ need: "optional", selectable: true, model_ids: ["muse-glimmer-30b-mlx-4bit"], engines: ["engine:chat-mlx", "engine:python"] });
      expect(plan.default_selected).not.toContain("chat-mlx");
      expect(plan.rows.find((candidate) => candidate.id === "engine:chat-mlx")).toBeDefined();
      const without = diskTotalsFor(plan, plan.default_selected);
      expect(diskTotalsFor(plan, [...plan.default_selected, "chat-mlx"]).download_bytes).toBeGreaterThanOrEqual(without.download_bytes + 19_443_246_692);
      expect(plan.default.download_bytes).toBe(without.download_bytes);
    } else expect(row).toBeUndefined();
  }
});

test("pictures is required on every tier that makes pictures", () => {
  for (const tier of PROFILE_TIERS) {
    const plan = buildDiskPlan(tier);
    const row = plan.rows.find((candidate) => candidate.id === "pictures");
    if (tier.notAvailable.includes("image")) { expect(row).toBeUndefined(); continue; }
    expect(row).toMatchObject({ label: "Change pictures (FLUX.2 Klein)", note: "Needed. Edits the pictures you already have, and makes new ones when ERNIE is not installed.", need: "required", selectable: false });
    // A required part rides the first-run install plan: Klein's pins are planned on exactly the tiers that have a pictures row.
    const planned = new Set(plannedPinsFor(tier).map((entry) => entry.pin.id));
    for (const pin of STACK_IMAGE_KLEIN_MODELS) expect(planned.has(pin.id)).toBe(true);
  }
  for (const tier of ["p16", "p32"]) {
    const planned = new Set(plannedPinsFor(PROFILE_TIERS.find((candidate) => candidate.id === tier)!).map((entry) => entry.pin.id));
    for (const pin of STACK_IMAGE_KLEIN_MODELS) expect(planned.has(pin.id)).toBe(false);
  }
});

test("video is recommended and video-detailed is optional on p128", () => {
  const plan = buildDiskPlan(PROFILE_TIERS.find((t) => t.id === "p128")!);
  expect(plan.rows.find((r) => r.id === "video")!).toMatchObject({ label: "Make videos (Wan2.2)", note: "Recommended. Makes a short clip from a sentence or a picture.", need: "recommended", selectable: true });
  const detailed = plan.rows.find((r) => r.id === "video-detailed")!;
  expect(detailed).toMatchObject({ label: "Detailed videos with sound (LTX-2.3)", need: "optional", selectable: true });
  expect(detailed.note).toContain("Optional");
  expect(detailed.note).toContain("74 GB");
  expect(detailed.note).toContain("licence");
  expect(detailed.note).not.toContain("On by default");
  // Neither video row rides the first-run plan: Quick is a recommended row the person can turn off, Detailed an optional extra.
  const planned = new Set(plannedPinsFor(PROFILE_TIERS.find((t) => t.id === "p128")!).map((entry) => entry.pin.id));
  for (const pin of STACK_VIDEO_MODELS) expect(planned.has(pin.id)).toBe(false);
});

test("the p128 default selection includes video and excludes video-detailed", () => {
  const plan = buildDiskPlan(PROFILE_TIERS.find((t) => t.id === "p128")!);
  expect(plan.default_selected).toContain("pictures");
  expect(plan.default_selected).toContain("video");
  expect(plan.default_selected).not.toContain("video-detailed");
});

test("Detailed video (LTX-2.3) is optional on p128 only: off by default, about 74 GB more free space when turned on, never in the first-run install plan (AIMODELS-DATA-01)", () => {
  const p128 = buildDiskPlan(PROFILE_TIERS.find((t) => t.id === "p128")!);
  const row = p128.rows.find((r) => r.id === "video-detailed")!;
  expect(row).toMatchObject({ need: "optional", selectable: true });
  expect(p128.default_selected).not.toContain("video-detailed");
  expect(row.download_bytes).toBeGreaterThan(70e9);
  const withDetailed = diskTotalsFor(p128, [...p128.default_selected, "video-detailed"]);
  expect(withDetailed.required_free_bytes - p128.default.required_free_bytes).toBeGreaterThan(70e9);
  for (const tier of PROFILE_TIERS) {
    const plan = buildDiskPlan(tier);
    if (tier.id !== "p128") expect(plan.rows.find((r) => r.id === "video-detailed")).toBeUndefined();
    // The install plan (what an install or an upgrade pulls on its own) never carries it: only a checked row or an explicit install does.
    expect(plannedPinsFor(tier).some((entry) => row.model_ids.includes(entry.pin.id))).toBe(false);
  }
});
