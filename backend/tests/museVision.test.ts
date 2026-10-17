// VISION-03a: Muse Glimmer 30B reads pictures itself. The repository's own
// projector loads beside the model in the one resident chat process (no
// second role, nothing extra to keep warm), pinned at the model's revision,
// and the install plan brings it for every tier that binds Muse.
import { expect, test } from "bun:test";
import { buildInstallPlan } from "@/lib/installPlan";
import { type HardwareInfo } from "@/lib/hardware";
import { STACK_CHAT_MUSE_30B_M_MODEL, STACK_CHAT_MUSE_30B_PROJECTOR, STACK_CHAT_MUSE_30B_XL_MODEL, STACK_MODELS } from "@/lib/modelCatalog";

const GB = 1_073_741_824;
const hw = (gb: number): HardwareInfo => ({ platform: "darwin", arch: "arm64", totalRamGb: gb, cpuCount: 12, isAppleSilicon: true, unifiedMemoryGb: gb, cudaDevices: [], freeDiskBytes: 500 * GB, osVersion: "test" });

test("the Muse projector is pinned at the model's revision with the repository's hash and size", () => {
  expect(STACK_MODELS).toContain(STACK_CHAT_MUSE_30B_PROJECTOR);
  expect(STACK_CHAT_MUSE_30B_PROJECTOR).toMatchObject({
    id: "muse-glimmer-30b-mmproj-q4-k-m", role: "chat", component: "projector", license: "Apache-2.0",
    repo: STACK_CHAT_MUSE_30B_XL_MODEL.repo, revision: STACK_CHAT_MUSE_30B_XL_MODEL.revision,
    download: { sha256: "f48b452316f9b213758e8659444029b961a24a07f99a1abb2a9f88b06f7c00c6", approx_bytes: 1_400_328_928 },
  });
  expect(STACK_CHAT_MUSE_30B_PROJECTOR.download!.url).toContain(`/resolve/${STACK_CHAT_MUSE_30B_XL_MODEL.revision}/mmproj-Muse-Glimmer-30B-Q4_K_M.gguf`);
});

test("both Muse pins declare the projector and bound one picture at 2,560 tokens, keeping the low reasoning strength", () => {
  for (const pin of [STACK_CHAT_MUSE_30B_XL_MODEL, STACK_CHAT_MUSE_30B_M_MODEL]) {
    expect(pin.imageInput).toEqual({ projector: STACK_CHAT_MUSE_30B_PROJECTOR.id });
    expect(pin.launch).toEqual({ chatTemplateKwargs: { reasoning_strength: "low" }, imageMaxTokens: 2560 });
  }
});

test("the install plan brings the projector with Muse on p32, p64 and p128, and not on p16", () => {
  for (const gb of [32, 64, 128]) {
    const ids = buildInstallPlan(hw(gb)).models.map((model) => model.id);
    expect(ids).toContain(STACK_CHAT_MUSE_30B_PROJECTOR.id);
    expect(new Set(ids).size).toBe(ids.length);
  }
  expect(buildInstallPlan(hw(16)).models.map((model) => model.id)).not.toContain(STACK_CHAT_MUSE_30B_PROJECTOR.id);
});
