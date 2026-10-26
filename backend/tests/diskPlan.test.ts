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

test("tiers: p16 and p32 have no generators, p64 has Klein and ERNIE, p128 adds Z-Image and video as optional extras", () => {
  const ids = (tier: string) => buildDiskPlan(PROFILE_TIERS.find((t) => t.id === tier)!).rows.map((row) => row.id);
  for (const tier of ["p16", "p32"]) for (const id of ["pictures", "pictures-ernie", "pictures-zimage", "video", "voice-better"]) expect(ids(tier)).not.toContain(id);
  expect(ids("p64")).toContain("pictures");
  expect(ids("p64")).toContain("pictures-ernie");
  expect(ids("p64")).toContain("voice-better");
  for (const id of ["pictures-zimage", "video"]) expect(ids("p64")).not.toContain(id);
  const p128 = buildDiskPlan(PROFILE_TIERS.find((t) => t.id === "p128")!);
  for (const id of ["pictures-zimage", "video"]) { const row = p128.rows.find((r) => r.id === id)!; expect(row.need).toBe("optional"); expect(p128.default_selected).not.toContain(id); }
  expect(p128.rows.find((r) => r.id === "pictures")!.need).toBe("recommended");
  for (const tier of ["p64", "p128"]) {
    const plan = buildDiskPlan(PROFILE_TIERS.find((candidate) => candidate.id === tier)!);
    const klein = plan.rows.find((row) => row.id === "pictures")!;
    const ernie = plan.rows.find((row) => row.id === "pictures-ernie")!;
    expect(klein).toMatchObject({ label: "Change pictures (FLUX.2 Klein)", note: "Recommended. Edits the pictures you already have, and makes new ones when ERNIE is not installed.", need: "recommended" });
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
  const withVideo = diskTotalsFor(plan, [...plan.default_selected, "video"]);
  // Detailed video is on by default and brings the video engine, so Quick video adds only its own weights.
  expect(plan.default_selected).toContain("video-detailed");
  expect(withVideo.installed_bytes - base.installed_bytes).toBe(video.installed_bytes);
  const noDetailed = diskTotalsFor(plan, plan.default_selected.filter((id) => id !== "video-detailed"));
  const withBoth = diskTotalsFor(plan, [...plan.default_selected.filter((id) => id !== "video-detailed"), "video"]);
  expect(withBoth.installed_bytes - noDetailed.installed_bytes).toBe(video.installed_bytes + videoEngine.installed_bytes);
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
  for (const id of ["pictures", "pictures-ernie", "pictures-zimage", "video"]) {
    const row = full.disk.rows.find((candidate) => candidate.id === id);
    if (!row) continue;
    expect(full.optional_models.map((m) => m.id).sort()).toEqual(expect.arrayContaining(row.model_ids.slice().sort()));
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

test("Detailed video (LTX-2.3) is recommended on p128 only: on by default, about 74 GB more free space, never in the first-run install plan (ENGINE-LTX-REC)", () => {
  const p128 = buildDiskPlan(PROFILE_TIERS.find((t) => t.id === "p128")!);
  const row = p128.rows.find((r) => r.id === "video-detailed")!;
  expect(row).toMatchObject({ need: "recommended", selectable: true });
  expect(p128.default_selected).toContain("video-detailed");
  expect(row.download_bytes).toBeGreaterThan(70e9);
  const without = diskTotalsFor(p128, p128.default_selected.filter((id) => id !== "video-detailed"));
  expect(p128.default.required_free_bytes - without.required_free_bytes).toBeGreaterThan(70e9);
  expect(p128.minimum.required_free_bytes).toBeLessThan(p128.default.required_free_bytes - 70e9);
  for (const tier of PROFILE_TIERS) {
    const plan = buildDiskPlan(tier);
    if (tier.id !== "p128") expect(plan.rows.find((r) => r.id === "video-detailed")).toBeUndefined();
    // The install plan (what an install or an upgrade pulls on its own) never carries it: only the wizard's checked row or an explicit install does.
    expect(plannedPinsFor(tier).some((entry) => row.model_ids.includes(entry.pin.id))).toBe(false);
  }
});
