import { expect, test } from "bun:test";
import { buildInstallPlan } from "@/lib/installPlan";
import { primaryBudgetBytes, sizingMemory, type HardwareInfo } from "@/lib/hardware";
import { proposeProfile } from "@/profiles";
import { STACK_MODELS } from "@/lib/modelCatalog";
import { app } from "@/app";

const GB = 1_073_741_824;
function hw(overrides: Partial<HardwareInfo>): HardwareInfo {
  return { platform: "darwin", arch: "arm64", totalRamGb: 16, cpuCount: 8, isAppleSilicon: true, unifiedMemoryGb: 16, cudaDevices: [], freeDiskBytes: 500 * GB, osVersion: "test", ...overrides };
}
const card = (index: number, gb: number) => ({ index, name: `card-${index}`, vramBytes: gb * GB });
const pc = (cards: number[], overrides: Partial<HardwareInfo> = {}) => hw({ platform: "linux", arch: "x64", isAppleSilicon: false, unifiedMemoryGb: 0, totalRamGb: 32, cudaDevices: cards.map((gb, index) => card(index, gb)), ...overrides });
const intelMac = () => hw({ arch: "x64", isAppleSilicon: false, unifiedMemoryGb: 0, totalRamGb: 16 });

test("sizing: two 8 GB cards sum to 16 GB of graphics memory and are Minimal", () => {
  const plan = buildInstallPlan(pc([8, 8]));
  expect([plan.level, plan.tier, plan.memory_gb, plan.memory_source]).toEqual(["minimal", "p16", 16, "graphics"]);
  expect(primaryBudgetBytes(pc([8, 8]))).toBe(16 * GB);
});
test("sizing: system RAM never counts without unified memory", () => {
  const plan = buildInstallPlan(pc([8], { totalRamGb: 128 }));
  expect([plan.level, plan.tier, plan.memory_gb, plan.memory_source, plan.models]).toEqual([null, null, 8, "graphics", []]);
});
test("sizing: a 16 GB Apple Silicon Mac is Minimal, 64 GB is Recommended (p64), all unified", () => {
  expect(buildInstallPlan(hw({ unifiedMemoryGb: 16, totalRamGb: 16 }))).toMatchObject({ level: "minimal", tier: "p16", memory_gb: 16, memory_source: "unified" });
  expect(buildInstallPlan(hw({ unifiedMemoryGb: 64, totalRamGb: 64 }))).toMatchObject({ level: "recommended", tier: "p64", memory_gb: 64, memory_source: "unified" });
});
test("sizing: shared graphics memory on another system counts as unified, plus any graphics memory", () => {
  expect(sizingMemory(pc([], { unifiedMemoryGb: 24, totalRamGb: 24 }))).toEqual({ bytes: 24 * GB, source: "unified" });
  expect(sizingMemory(pc([8], { unifiedMemoryGb: 24, totalRamGb: 24 }))).toEqual({ bytes: 32 * GB, source: "unified" });
  expect(proposeProfile(pc([8], { unifiedMemoryGb: 24, totalRamGb: 24 }))?.id).toBe("p32");
});
test("sizing: a 16 GB card that reports 15.99 GiB still counts as 16", () => {
  expect(proposeProfile({ ...pc([]), cudaDevices: [{ index: 0, name: "a", vramBytes: 16_376 * 1_048_576 }] })?.id).toBe("p16");
});
test("sizing: an Intel Mac with no GPU is unknown, not zero", () => {
  expect(buildInstallPlan(intelMac())).toMatchObject({ level: null, tier: null, memory_gb: 0, memory_source: "unknown", models: [], total_bytes: 0 });
});
test("sizing: unknown VRAM with an override is sized from it; without one it stays null", () => {
  expect(buildInstallPlan(intelMac(), { vramOverrideGb: 24 })).toMatchObject({ level: "minimal", tier: "p16", memory_gb: 24, memory_source: "override" });
  expect(buildInstallPlan(intelMac(), { vramOverrideGb: 8 })).toMatchObject({ level: null, memory_source: "override", memory_gb: 8 });
  expect(buildInstallPlan(intelMac(), { vramOverrideGb: 64 }).tier).toBe("p64");
});
test("sizing: the override never replaces a detected figure", () => {
  expect(buildInstallPlan(pc([8]), { vramOverrideGb: 64 })).toMatchObject({ level: null, memory_gb: 8, memory_source: "graphics" });
  expect(buildInstallPlan(hw({}), { vramOverrideGb: 8 })).toMatchObject({ memory_gb: 16, memory_source: "unified" });
});

test("plan: every model is a complete pull body from a shipped pin", () => {
  const plan = buildInstallPlan(hw({ unifiedMemoryGb: 64, totalRamGb: 64 }));
  expect(plan.models.length).toBeGreaterThan(0);
  for (const model of plan.models) {
    const pin = STACK_MODELS.find((candidate) => candidate.id === model.id)!;
    expect(pin).toBeDefined();
    expect(model).toMatchObject({ role: pin.role, url: pin.download!.url, sha256: pin.download!.sha256, approx_bytes: pin.download!.approx_bytes, licence: pin.license, revision: pin.revision, engine: pin.engine });
    expect(model.sha256).toHaveLength(64);
  }
  const ids = plan.models.map((model) => model.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toContain("qwen3-4b-q4-k-m");
  expect(ids).toContain("moonshine-tiny-en-int8");
  expect(ids).toContain("silero-vad");
  expect(ids).toContain("pocket-tts-english-tokenizer");
  expect(ids).not.toContain("qwen3-vl-8b-instruct-mmproj-q8-0");
  expect(plan.models.find((model) => model.id === "pocket-tts-english")).toMatchObject({ hub_file: "languages/english/model.safetensors" });
  expect(plan.models.find((model) => model.id === "moonshine-tiny-en-int8")).toMatchObject({ archive: true });
});
test("plan: the starter is first, then chat, stt, tts, embed, judge", () => {
  const plan = buildInstallPlan(hw({ unifiedMemoryGb: 64, totalRamGb: 64 }));
  expect(plan.models[0]).toMatchObject({ id: "qwen3-1.7b-q8-0", starter: true });
  expect(plan.models.filter((model) => model.starter)).toHaveLength(1);
  expect(plan.models.filter((model) => !model.component).map((model) => model.role)).toEqual(["chat", "chat", "stt", "tts", "tts", "embed", "judge"]);
  // STACK-MUSE-01: above 24 GB the bound chat is Muse Glimmer 30B, so the
  // 8B is not in this plan at all.
  expect(plan.models[1]).toMatchObject({ id: "muse-glimmer-30b-q4-k-xl", starter: false });
  expect(plan.models.map((model) => model.id)).not.toContain("qwen3-8b-instruct-q4-k-m");
});
test("plan: the chat pull follows the tier (STACK-MUSE-01): 8B through 24 GB, Muse Q4_K_M at 32 GB, Q4_K_XL from 64 GB", () => {
  const chatOf = (gb: number) => buildInstallPlan(hw({ unifiedMemoryGb: gb, totalRamGb: gb })).models[1]?.id;
  expect(chatOf(24)).toBe("qwen3-8b-instruct-q4-k-m");
  expect(chatOf(32)).toBe("muse-glimmer-30b-q4-k-m");
  expect(chatOf(64)).toBe("muse-glimmer-30b-q4-k-xl");
  expect(chatOf(128)).toBe("muse-glimmer-30b-q4-k-xl");
  const p32 = buildInstallPlan(hw({ unifiedMemoryGb: 32, totalRamGb: 32 }));
  expect(p32.models.find((model) => model.id === "muse-glimmer-30b-q4-k-m")).toMatchObject({ approx_bytes: 16_756_683_904, role: "chat", starter: false });
});
test("plan: oMLX's MLX build of Muse is never in the first-run plan; llama-server is the default on every tier (ENGINE-MLX-02)", () => {
  const mlxIn = (plan: ReturnType<typeof buildInstallPlan>) => plan.models.find((model) => model.id === "muse-glimmer-30b-mlx-4bit");
  for (const gb of [16, 24, 32, 64, 128]) expect(mlxIn(buildInstallPlan(hw({ unifiedMemoryGb: gb, totalRamGb: gb })))).toBeUndefined();
  expect(buildInstallPlan(hw({ unifiedMemoryGb: 128, totalRamGb: 128 })).models.map((model) => model.id)).toContain("muse-glimmer-30b-q4-k-xl");
});
test("plan: p16 has the larger chat bound, so the small pin is still the starter; embeddings ride along", () => {
  const plan = buildInstallPlan(hw({}));
  expect(plan.models.map((model) => model.id).slice(0, 2)).toEqual(["qwen3-1.7b-q8-0", "qwen3-8b-instruct-q4-k-m"]);
  expect(plan.models.some((model) => model.role === "embed")).toBe(true);
  expect(plan.models.some((model) => model.role === "judge")).toBe(false);
});
test("plan: installed models are flagged and leave remaining_bytes; disk fit follows remaining", () => {
  const full = buildInstallPlan(hw({}));
  const part = buildInstallPlan(hw({ freeDiskBytes: 1 }), { installedIds: ["qwen3-8b-instruct-q4-k-m"] });
  expect(part.models.find((model) => model.id === "qwen3-8b-instruct-q4-k-m")?.installed).toBe(true);
  expect(part.total_bytes).toBe(full.total_bytes);
  expect(part.remaining_bytes).toBe(full.total_bytes - 5_027_783_488);
  expect(part.fits_disk).toBe(false);
  expect(full.fits_disk).toBe(true);
  expect(full.free_disk_bytes).toBe(500 * GB);
  const unknownDisk = buildInstallPlan({ ...hw({}), freeDiskBytes: undefined });
  expect([unknownDisk.free_disk_bytes, unknownDisk.fits_disk]).toEqual([null, null]);
});

test("route: answers the plan, accepts vram_gb in range and refuses it out of range", async () => {
  const ok = await app.request("/stack/v1/install-plan");
  expect(ok.status).toBe(200);
  const body = await ok.json() as { models: unknown[]; memory_source: string };
  expect(Array.isArray(body.models)).toBe(true);
  expect(["unified", "graphics", "override", "unknown"]).toContain(body.memory_source);
  expect((await app.request("/stack/v1/install-plan?vram_gb=0")).status).toBe(400);
  expect((await app.request("/stack/v1/install-plan?vram_gb=513")).status).toBe(400);
  expect((await app.request("/stack/v1/install-plan?vram_gb=1.5")).status).toBe(400);
  expect((await app.request("/stack/v1/install-plan?vram_gb=24")).status).toBe(200);
});
