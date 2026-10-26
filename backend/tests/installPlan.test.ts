import { expect, test } from "bun:test";
import { buildInstallPlan } from "@/lib/installPlan";
import { primaryBudgetBytes, sizingMemory, type HardwareInfo } from "@/lib/hardware";
import { proposeProfile, PROFILE_MODEL_BINDINGS } from "@/profiles";
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
  expect(ids).toContain("parakeet-tdt-0.6b-v2-int8");
  expect(ids).toContain("silero-vad");
  expect(ids).toContain("pocket-tts-english-tokenizer");
  expect(ids).not.toContain("qwen3-vl-8b-instruct-mmproj-q8-0");
  expect(plan.models.find((model) => model.id === "pocket-tts-english")).toMatchObject({ hub_file: "languages/english/model.safetensors" });
  expect(plan.models.find((model) => model.id === "parakeet-tdt-0.6b-v2-int8")).toMatchObject({ archive: true });
});
test("plan: the starter is first, then chat, stt, tts, embed, judge", () => {
  const plan = buildInstallPlan(hw({ unifiedMemoryGb: 64, totalRamGb: 64 }));
  expect(plan.models[0]).toMatchObject({ id: "qwen3-1.7b-q8-0", starter: true });
  expect(plan.models.filter((model) => model.starter)).toHaveLength(1);
  // Klein is a required disk-plan row on p64 (AIMODELS-DATA-01), so the picture model rides the plan.
  expect(plan.models.filter((model) => !model.component).map((model) => model.role)).toEqual(["chat", "chat", "stt", "tts", "tts", "embed", "judge", "coding", "image"]);
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

// CODE-STACK-01 S1: the recommended setup brings the coding model on p64 and p128, removable; never on p16 or p32.
test("plan: p64 and p128 include the coding model as a removable pull body; p16 and p32 never do", () => {
  for (const gb of [64, 128]) {
    const plan = buildInstallPlan(hw({ unifiedMemoryGb: gb, totalRamGb: gb }));
    const coding = plan.models.filter((model) => model.role === "coding");
    // The model, and (S5a) Splash's draft beside it on Apple silicon: both removable, the draft a component of the coding model.
    expect(coding.map((model) => model.id)).toEqual(["qwen3.8-27b-ud-q4-k-m", "qwen3.8-27b-dflash2-draft"]);
    expect(coding[1]).toMatchObject({ id: "qwen3.8-27b-dflash2-draft", component: "draft", engine: "splash", removable: true, approx_bytes: 3_848_817_896, repo: "incoai/Qwen3.8-27B-DFlash2", revision: "015e795645c74b1a0eeef3b570031fb62e769bc5", licence: "Apache-2.0", sha256: "67fc76d68dc5a9415511a4f394ef744d67510cd20e93b37cc2cc7d28e4bab65c" });
    expect(coding[0]).toMatchObject({ id: "qwen3.8-27b-ud-q4-k-m", removable: true, starter: false, installed: false, approx_bytes: 16_464_440_224, licence: "Apache-2.0", engine: "llama-server", revision: "4ca720788d1e01f1bff70c033e0d0028fd02e502", sha256: "322e194ff79741c7baa497c240f677f54b201b0efab44ca8e50f122b39123482" });
    // Only the coding model and its draft are flagged removable; everything else is required.
    expect(plan.models.filter((model) => model.removable).map((model) => model.id)).toEqual(["qwen3.8-27b-ud-q4-k-m", "qwen3.8-27b-dflash2-draft"]);
    // Chat is still the starter pair and still first; coding changes neither.
    expect(plan.models[0]).toMatchObject({ id: "qwen3-1.7b-q8-0", starter: true });
    expect(plan.models[1]).toMatchObject({ id: "muse-glimmer-30b-q4-k-xl", starter: false });
  }
  for (const gb of [16, 24, 32]) {
    const plan = buildInstallPlan(hw({ unifiedMemoryGb: gb, totalRamGb: gb }));
    expect(plan.models.some((model) => model.role === "coding" || model.id === "qwen3.8-27b-ud-q4-k-m")).toBe(false);
    expect(plan.models.some((model) => model.removable)).toBe(false);
  }
});
test("plan: the coding model adds its size to the totals and a pull body for it is complete", () => {
  const with64 = buildInstallPlan(hw({ unifiedMemoryGb: 64, totalRamGb: 64 }));
  expect(with64.total_bytes).toBe(with64.models.reduce((sum, model) => sum + model.approx_bytes, 0));
  const installed = buildInstallPlan(hw({ unifiedMemoryGb: 64, totalRamGb: 64 }), { installedIds: ["qwen3.8-27b-ud-q4-k-m"] });
  expect(installed.models.find((model) => model.id === "qwen3.8-27b-ud-q4-k-m")?.installed).toBe(true);
  expect(installed.remaining_bytes).toBe(with64.total_bytes - 16_464_440_224);
  // The draft is part of the total and of what is left until it is installed too.
  const both = buildInstallPlan(hw({ unifiedMemoryGb: 64, totalRamGb: 64 }), { installedIds: ["qwen3.8-27b-ud-q4-k-m", "qwen3.8-27b-dflash2-draft"] });
  expect(both.remaining_bytes).toBe(with64.total_bytes - 16_464_440_224 - 3_848_817_896);
});
test("route: the plan's coding model carries removable: true in the response", async () => {
  const body = await (await app.request("/stack/v1/install-plan?vram_gb=64")).json() as { models: Array<{ id: string; removable?: boolean }> };
  const entries = body.models.filter((model) => model.id === "qwen3.8-27b-ud-q4-k-m");
  // The route sizes from the real machine first; the override only applies when none is detected, so assert the shape either way.
  for (const entry of entries) expect(entry.removable).toBe(true);
  expect(body.models.filter((model) => model.removable).every((model) => model.id === "qwen3.8-27b-ud-q4-k-m" || model.id === "qwen3.8-27b-dflash2-draft")).toBe(true);
});

test("plan: stt is Parakeet alone on p64 and p128, Moonshine alone on p16 and p32 (STT-PARAKEET-03)", () => {
  const sttIds = (gb: number) => buildInstallPlan(hw({ unifiedMemoryGb: gb, totalRamGb: gb })).models.filter((model) => model.role === "stt" && !model.component).map((model) => model.id);
  expect(sttIds(16)).toEqual(["moonshine-tiny-en-int8"]);
  expect(sttIds(32)).toEqual(["moonshine-tiny-en-int8"]);
  expect(sttIds(64)).toEqual(["parakeet-tdt-0.6b-v2-int8"]);
  expect(sttIds(128)).toEqual(["parakeet-tdt-0.6b-v2-int8"]);
  for (const gb of [16, 32, 64, 128]) expect(buildInstallPlan(hw({ unifiedMemoryGb: gb, totalRamGb: gb })).models.filter((model) => model.id === "silero-vad")).toHaveLength(1);
  expect(Object.entries(PROFILE_MODEL_BINDINGS).map(([tier, bound]) => [tier, bound?.stt])).toEqual([["p16", "moonshine-tiny-en-int8"], ["p32", "moonshine-tiny-en-int8"], ["p64", "parakeet-tdt-0.6b-v2-int8"], ["p128", "parakeet-tdt-0.6b-v2-int8"]]);
});
