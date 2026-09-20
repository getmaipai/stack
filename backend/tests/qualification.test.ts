// STACK-86: the one chat model pin and the llama-server engine pin, held
// offline against their own declarations. A loosened pin — a `main`
// revision, a missing digest or licence, a tier the declared footprint no
// longer fits — fails this test.
import { describe, expect, test } from "bun:test";
import { STACK_CHAT_MODEL } from "@/lib/modelCatalog";
import { ENGINE_BINARIES, type EngineBinaryPin } from "@/lib/engineCatalog";
import { PROFILE_TIERS, type ProfileTier } from "@/profiles";
import { GovernorRules } from "@/lib/governor";
import { SETTINGS } from "@/settings";

const GB = 1_073_741_824;
const contextLength: number = ((SETTINGS.find((entry) => entry.key === "stack.engines.llama_server.context_length")?.default as number | undefined) ?? 4096);
const engineMultiplier = GovernorRules.engineMultipliers["llama-server"] ?? GovernorRules.engineMultipliers.default;

// Qwen3-1.7B: 28 layers, kv_head 8, head_dim 96. q8_0 KV cache: 34/32
// bytes per element, keys and values.
export function chatPinFootprintBytes(_tier: ProfileTier): number {
  const fileBytes = STACK_CHAT_MODEL.download?.approx_bytes ?? 0;
  const kvBytes = 2 * 28 * 8 * 96 * (34 / 32) * contextLength;
  return Math.ceil(fileBytes * engineMultiplier) + kvBytes;
}

export function chatPinTierBudgetBytes(tier: ProfileTier): number {
  return tier.minUnifiedGb * GB - GovernorRules.osMarginBytes;
}

export function chatPinFitsTier(tier: ProfileTier): boolean {
  return chatPinFootprintBytes(tier) <= chatPinTierBudgetBytes(tier);
}

describe("chat model pin", () => {
  test("the revision is an immutable Hub commit, not a branch", () => {
    const revision = STACK_CHAT_MODEL.revision;
    expect(revision).toMatch(/^[a-f0-9]{40}$/);
    expect(revision).not.toBe("main");
  });

  test("the download URL resolves the pinned commit, not main", () => {
    const url = STACK_CHAT_MODEL.download?.url;
    expect(url).toBeTruthy();
    expect(url).toContain(`/resolve/${STACK_CHAT_MODEL.revision}/`);
    expect(url).not.toContain("/resolve/main/");
  });

  test("the declared size is the file size the Hub reports for the commit", () => {
    expect(STACK_CHAT_MODEL.download?.approx_bytes).toBe(1_834_426_016);
  });

  test("the declared digest is a SHA-256 of the pinned file", () => {
    expect(STACK_CHAT_MODEL.download?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(STACK_CHAT_MODEL.download?.sha256).toBe("061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a");
  });

  test("the licence id is declared", () => {
    expect(STACK_CHAT_MODEL.license).toBe("Apache-2.0");
  });

  test("the pin fits every tier at or above its declared one, with governor headroom", () => {
    const tierIds = PROFILE_TIERS.map((tier) => tier.id);
    const declaredTier: ProfileTier["id"] | undefined = typeof STACK_CHAT_MODEL.sizing === "object" && STACK_CHAT_MODEL.sizing !== null && "profile" in STACK_CHAT_MODEL.sizing ? (STACK_CHAT_MODEL.sizing as { profile: ProfileTier["id"] }).profile : undefined;
    expect(declaredTier).toBe("p16");
    for (const tier of PROFILE_TIERS) {
      if (tierIds.indexOf(tier.id) < tierIds.indexOf(declaredTier ?? "p16")) continue;
      expect(chatPinFitsTier(tier)).toBe(true);
      expect(chatPinFootprintBytes(tier) + GovernorRules.tiers[tier.id].workingMarginBytes).toBeLessThanOrEqual(tier.minUnifiedGb * GB);
    }
    const p16 = PROFILE_TIERS.find((tier) => tier.id === "p16")!;
    expect(chatPinFootprintBytes(p16) + GovernorRules.tiers.p16.workingMarginBytes).toBeLessThanOrEqual(p16.minUnifiedGb * GB);
  });
});

describe("engine pin", () => {
  const pin: EngineBinaryPin | undefined = ENGINE_BINARIES.find((entry) => entry.id === "llama-server-b10797-macos-arm64");

  test("the macOS pin declares its build tag", () => {
    expect(pin?.id).toBe("llama-server-b10797-macos-arm64");
    expect(pin?.archive?.url).toContain("/releases/download/b10797/");
    expect(pin?.label).toContain("b10797");
  });

  test("every engine pin declares an asset digest", () => {
    for (const entry of ENGINE_BINARIES) {
      expect(entry.archive.sha256).toMatch(/^[a-f0-9]{64}$/);
      for (const extra of entry.extraArchives ?? []) expect(extra.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  test("the verified macOS pin is the one the chat model runs on", () => {
    expect(pin?.verified).toBe(true);
    expect(pin?.platform).toBe("darwin");
    expect(pin?.arch).toBe("arm64");
  });
});
