import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetJobsForTests, listJobs } from "@/lib/jobs";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly } from "@/lib/governor";
import { __resetMemoryStateForTests } from "@/lib/memoryState";
import { registerVideoJobs } from "@/video/jobs";
import { qualityOfModelName, videoGen, type VideoGenDeps } from "@/video/videoGen";
import { STACK_VIDEO_MODEL } from "@/lib/modelCatalog";
import { STACK_MODELS, STACK_VIDEO_LTX25_MODEL_ID, STACK_VIDEO_LTX25_MAX_MODEL_ID, STACK_MUSIC_MODEL_ID, STACK_IMAGE_KLEIN_ID, STACK_IMAGE_ERNIE_ID } from "@/lib/modelCatalog";
import { STACK_VIDEO_LTX25_MODELS, STACK_VIDEO_LTX25_MAX_MODELS, STACK_VIDEO_MODELS, STACK_MUSIC_MODELS, STACK_IMAGE_KLEIN_MODELS, STACK_IMAGE_ERNIE_MODELS } from "@/lib/modelCatalog";
import { componentDefs, listComponents } from "@/lib/components";
import { diskPlanForTier } from "@/lib/diskPlan";
import { buildInstallPlan } from "@/lib/installPlan";
import { PROFILE_TIERS } from "@/profiles";

import { writeModelManifest, readModelManifest } from "@/lib/store/manifests";
import { plannedPinsFor } from "@/lib/installPlan";
import { clearModelsForTests } from "@/lib/modelStore";
import type { HardwareInfo } from "@/lib/hardware";

const GB = 1_073_741_824;
const hardware: HardwareInfo = { platform: "darwin", arch: "arm64", totalRamGb: 128, cpuCount: 16, isAppleSilicon: true, unifiedMemoryGb: 128, cudaDevices: [], freeDiskBytes: 2_000 * GB, osVersion: "test" };
let spawned: string[] = [];
function deps(): VideoGenDeps {
  return { supported: () => true, ensureEnvironment: async () => {}, paths: () => ({ modelDir: "/models/wan", tokenizerDir: "/models/tokenizer" }), spawn: async (quality) => { spawned.push(quality); throw new Error("retired request must not spawn"); } };
}
const post = (model: string) => app.request("/v1/videos/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "a quiet garden", model }) });

beforeEach(() => {
  spawned = []; clearModelsForTests(); videoGen.useDeps(deps()); __resetJobsForTests(); __resetGovernorForTests(); __resetMemoryStateForTests();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB, tier: "p128" }); registerVideoJobs();
});
afterEach(() => { videoGen.useDeps(null); __resetJobsForTests(); __resetGovernorForTests(); __resetMemoryStateForTests(); });

test("retired Detailed names are recognized for refusal and never start a job", async () => {
  expect(qualityOfModelName("detailed")).toBeNull();
  expect(qualityOfModelName("ltx-2-3-distilled-mlx")).toBeNull();
  for (const model of ["detailed", "ltx-2-3-distilled-mlx"]) {
    const response = await post(model);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "retired_model", error: "The Detailed video model was retired. Use ltx25-q8 or ltx25-max." });
  }
  expect(spawned).toEqual([]);
  expect(listJobs()).toEqual([]);
});

test("video status keeps the additive Detailed compatibility entry marked retired", async () => {
  const response = await app.request("/stack/v1/video");
  expect(response.status).toBe(200);
  const body = await response.json() as { video: { qualities: { detailed: { id: string; installed: boolean; available: boolean; reason?: string }; quick: { id: string } }; } };
  expect(body.video.qualities.detailed).toMatchObject({ installed: false, available: false, reason: "The Detailed video model was retired. Use ltx25 or ltx25max." });
  expect(body.video.qualities.quick.id).toBe(STACK_VIDEO_MODEL.id);
});

test("catalog, component list and p128 plans no longer carry the retired model or Gemma encoder", async () => {
  const catalogIds = STACK_MODELS.map((pin) => pin.id);
  const componentIds = componentDefs().flatMap((component) => component.pins.map((pin) => pin.id));
  expect(catalogIds.some((id) => id === "ltx-2-3-distilled-mlx" || id === "video-gemma-3-12b-text-encoder")).toBe(false);
  expect(componentIds.some((id) => id === "ltx-2-3-distilled-mlx" || id === "video-gemma-3-12b-text-encoder")).toBe(false);
  const components = await listComponents(hardware);
  expect(components.components.some((component) => component.id === "ltx-2-3-distilled-mlx")).toBe(false);
  const disk = diskPlanForTier("p128")!;
  expect(disk.rows.some((row) => row.id === "video-detailed" || row.model_ids.some((id) => id.includes("ltx-2-3") || id.includes("gemma-3-12b")))).toBe(false);
  const install = buildInstallPlan(hardware);
  expect(install.models.some((model) => model.id.includes("ltx-2-3") || model.id.includes("gemma-3-12b"))).toBe(false);
  expect(plannedPinsFor(PROFILE_TIERS.find((tier) => tier.id === "p128")!).some((entry) => entry.pin.id.includes("ltx-2-3") || entry.pin.id.includes("gemma-3-12b"))).toBe(false);
});

test("LTX-2.5, Wan, music and picture components retain their fresh-machine fixture states", async () => {
  clearModelsForTests();
  const list = await listComponents(hardware);
  const fixture = [
    [STACK_VIDEO_MODEL.id, "notInstalled"], [STACK_VIDEO_LTX25_MODEL_ID, "notInstalled"], [STACK_VIDEO_LTX25_MAX_MODEL_ID, "notInstalled"],
    [STACK_MUSIC_MODEL_ID, "notInstalled"], [STACK_IMAGE_KLEIN_ID, "notInstalled"], [STACK_IMAGE_ERNIE_ID, "notInstalled"],
  ];
  const actual = fixture.map(([id]) => { const component = list.components.find((item) => item.id === id); return [id, component?.state]; });
  expect(actual).toEqual(fixture);
  expect(STACK_VIDEO_LTX25_MODELS.map((pin) => pin.id)).toEqual([STACK_VIDEO_LTX25_MODEL_ID]);
  expect(STACK_VIDEO_LTX25_MAX_MODELS.map((pin) => pin.id)).toEqual([STACK_VIDEO_LTX25_MAX_MODEL_ID]);
  expect(STACK_VIDEO_MODELS.map((pin) => pin.id)).toContain(STACK_VIDEO_MODEL.id);
  expect(STACK_MUSIC_MODELS.map((pin) => pin.id)).toContain(STACK_MUSIC_MODEL_ID);
  expect(STACK_IMAGE_KLEIN_MODELS.map((pin) => pin.id)).toContain(STACK_IMAGE_KLEIN_ID);
  expect(STACK_IMAGE_ERNIE_MODELS.map((pin) => pin.id)).toContain(STACK_IMAGE_ERNIE_ID);
});
