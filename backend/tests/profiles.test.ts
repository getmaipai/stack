import { expect, test } from "bun:test";
import { PROFILE_MODEL_BINDINGS, PROFILE_TIERS, proposeProfile } from "@/profiles";
import { STACK_CODING_MODEL, STACK_MODELS } from "@/lib/modelCatalog";
import { ROLES, type RoleId } from "@/roles";
import type { HardwareInfo } from "@/lib/hardware";

function hw(overrides: Partial<HardwareInfo>): HardwareInfo {
  return {
    platform: "darwin",
    arch: "arm64",
    totalRamGb: 16,
    cpuCount: 8,
    isAppleSilicon: true,
    unifiedMemoryGb: 16,
    cudaDevices: [],
    freeDiskBytes: 100,
    osVersion: "test",
    ...overrides,
  };
}

test("a 24 GB Apple Mac is Minimal", () => {
  expect(proposeProfile(hw({ unifiedMemoryGb: 24 }))?.level).toBe("minimal");
});

test("a 32 GB Apple Mac is Moderate", () => {
  expect(proposeProfile(hw({ unifiedMemoryGb: 32 }))?.level).toBe("moderate");
});

test("a 64 GB Apple Mac is Recommended", () => {
  expect(proposeProfile(hw({ unifiedMemoryGb: 64 }))?.level).toBe("recommended");
});

test("a two-card box with 8 GB each is Minimal", () => {
  expect(proposeProfile(hw({
    isAppleSilicon: false,
    unifiedMemoryGb: 0,
    totalRamGb: 16,
    cudaDevices: [
      { index: 0, name: "test-0", vramBytes: 8 * 1_073_741_824 },
      { index: 1, name: "test-1", vramBytes: 8 * 1_073_741_824 },
    ],
  }))?.level).toBe("minimal");
});

test("a single 8 GB card is below Minimal", () => {
  expect(proposeProfile(hw({ isAppleSilicon: false, unifiedMemoryGb: 0, totalRamGb: 16,
    cudaDevices: [{ index: 0, name: "test", vramBytes: 8 * 1_073_741_824 }] }))).toBeNull();
});

test("a 12 GB card is refused", () => {
  expect(proposeProfile(hw({ isAppleSilicon: false, unifiedMemoryGb: 0, totalRamGb: 16,
    cudaDevices: [{ index: 0, name: "test", vramBytes: 12 * 1_073_741_824 }] }))).toBeNull();
});

test("an Intel Mac or PC with no supported graphics is refused", () => {
  expect(proposeProfile(hw({ platform: "darwin", arch: "x64", isAppleSilicon: false, unifiedMemoryGb: 0 }))).toBeNull();
  expect(proposeProfile(hw({ platform: "linux", arch: "x64", isAppleSilicon: false, unifiedMemoryGb: 0 }))).toBeNull();
});

test("each tier's role lists are disjoint and cover every role", () => {
  const roles: RoleId[] = ["chat", "coding", "judge", "router", "embed", "rerank", "vision", "stt", "tts", "wakeword", "image", "video", "music"];
  for (const tier of PROFILE_TIERS) {
    const all = [...tier.resident, ...tier.onDemand, ...tier.installedOnly, ...tier.notAvailable];
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all)).toEqual(new Set(roles));
  }
});

test("the chat pin is Qwen3 8B through 24 GB and Muse Glimmer 30B above (STACK-MUSE-01)", () => {
  expect(proposeProfile(hw({ unifiedMemoryGb: 24 }))?.id).toBe("p16");
  expect(proposeProfile(hw({ unifiedMemoryGb: 32 }))?.id).toBe("p32");
  expect(proposeProfile(hw({ unifiedMemoryGb: 128 }))?.id).toBe("p128");
  expect(PROFILE_MODEL_BINDINGS.p16?.chat).toBe("qwen3-8b-instruct-q4-k-m");
  expect(PROFILE_MODEL_BINDINGS.p32?.chat).toBe("muse-glimmer-30b-q4-k-m");
  expect(PROFILE_MODEL_BINDINGS.p64?.chat).toBe("muse-glimmer-30b-q4-k-xl");
  expect(PROFILE_MODEL_BINDINGS.p128?.chat).toBe("muse-glimmer-30b-q4-k-xl");
  for (const tier of ["p32", "p64", "p128"] as const) expect(PROFILE_MODEL_BINDINGS[tier]?.judge).toBe("qwen3-4b-q4-k-m");
});

// INSTANT-02: Home sends an Instant chat turn to the judge role. That only
// works if the judge is a chat-wire role with its own, smaller model on
// every tier that can hold two; on p16 it shares the one chat model.
test("the judge role is a chat-wire role bound to a model other than chat from p32 up", () => {
  expect(ROLES.judge.wire).toBe("chat");
  expect(ROLES.judge.endpoints).toContain("/v1/chat/completions");
  for (const tier of ["p32", "p64", "p128"] as const) {
    const bindings = PROFILE_MODEL_BINDINGS[tier];
    expect(bindings?.judge).toBeDefined();
    expect(bindings?.judge).not.toBe(bindings?.chat);
  }
  expect(PROFILE_MODEL_BINDINGS.p16?.judge).toBeUndefined();
});

// CODE-STACK-01 S1: coding has its own model from p64 and is never resident.
test("coding is unavailable on p16 and p32, on demand on p64 and p128, and never resident", () => {
  const tier = (id: string) => PROFILE_TIERS.find((candidate) => candidate.id === id)!;
  for (const id of ["p16", "p32"]) {
    expect(tier(id).notAvailable).toContain("coding");
    expect(tier(id).resident).not.toContain("coding");
    expect(tier(id).onDemand).not.toContain("coding");
  }
  for (const id of ["p64", "p128"]) {
    expect(tier(id).onDemand).toContain("coding");
    expect(tier(id).resident).not.toContain("coding");
    expect(tier(id).notAvailable).not.toContain("coding");
  }
});
test("coding binds Qwen3.8-27B UD-Q4_K_M on p64 and p128 only, and the binding resolves to a complete pin", () => {
  expect(PROFILE_MODEL_BINDINGS.p16?.coding).toBeUndefined();
  expect(PROFILE_MODEL_BINDINGS.p32?.coding).toBeUndefined();
  for (const id of ["p64", "p128"] as const) {
    const pin = STACK_MODELS.find((candidate) => candidate.id === PROFILE_MODEL_BINDINGS[id]?.coding)!;
    expect(pin).toBe(STACK_CODING_MODEL);
    expect(pin).toMatchObject({ id: "qwen3.8-27b-ud-q4-k-m", role: "coding", repo: "unsloth/Qwen3.8-27B-GGUF", license: "Apache-2.0", engine: "llama-server", revision: "4ca720788d1e01f1bff70c033e0d0028fd02e502" });
    expect(pin.download).toMatchObject({ sha256: "322e194ff79741c7baa497c240f677f54b201b0efab44ca8e50f122b39123482", approx_bytes: 16_464_440_224 });
    expect(pin.download!.url).toBe("https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/4ca720788d1e01f1bff70c033e0d0028fd02e502/Qwen3.8-27B-UD-Q4_K_M.gguf");
    expect(pin.sampling).toMatchObject({ temperature: 1.0, top_p: 0.95, top_k: 20, presence_penalty: 0.0 });
    expect(pin.sampling!.source).toContain("Qwen/Qwen3.8-27B model card");
  }
});
test("the coding binding does not touch chat or the judge on any tier", () => {
  expect(PROFILE_MODEL_BINDINGS.p16).toEqual({ chat: "qwen3-8b-instruct-q4-k-m", stt: "moonshine-tiny-en-int8" });
  expect(PROFILE_MODEL_BINDINGS.p32).toEqual({ chat: "muse-glimmer-30b-q4-k-m", judge: "qwen3-4b-q4-k-m", stt: "moonshine-tiny-en-int8" });
  for (const id of ["p64", "p128"] as const) expect(PROFILE_MODEL_BINDINGS[id]).toEqual({ chat: "muse-glimmer-30b-q4-k-xl", judge: "qwen3-4b-q4-k-m", coding: "qwen3.8-27b-ud-q4-k-m", stt: "parakeet-tdt-0.6b-v2-int8" });
  // The coding model, and Splash's draft beside it (S5a), a component that no tier binds and nothing selects.
  expect(STACK_MODELS.filter((pin) => pin.role === "coding").map((pin) => pin.id)).toEqual(["qwen3.8-27b-ud-q4-k-m", "qwen3.8-27b-dflash2-draft", "ornith-1-5-122b-mlx-4bit", "ornith-1-5-122b-dflash2-draft"]);
  expect(STACK_MODELS.filter((pin) => pin.role === "coding" && !pin.component).map((pin) => pin.id)).toEqual(["qwen3.8-27b-ud-q4-k-m", "ornith-1-5-122b-mlx-4bit"]);
});
