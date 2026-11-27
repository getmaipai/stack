// The 128 GB computer's recommended model per level is the owner's lineup (Jesse, 2026-11-25): the p128 rows of
// rows/tierCandidates.json sit so the resolver picks it, while p64 and p32 keep their own recommendations and every model the
// lineup dropped stays a pick in Custom (dropped from the preset, never deleted).
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { StackPartView } from "@maipai/spec/stack/ts/stack-part-view.js";
import { app } from "@/app";
import { __resetChoicesForTests } from "@/lib/choicesStore";
import { __setChoicesDepsForTests } from "@/lib/choices";
import { __resetPartChoicesForTests } from "@/lib/partChoices";
import { __resetSettingsForTests } from "@/settings";
import { __setProfileDepsForTests } from "@/routes/profiles";
import { resolveTier, TIER_CANDIDATES } from "@/lib/tiers";
import type { HardwareInfo } from "@/lib/hardware";

const hw = (gb: number): HardwareInfo => ({ platform: "darwin", arch: "arm64", totalRamGb: gb, cpuCount: 8, isAppleSilicon: true, unifiedMemoryGb: gb, cudaDevices: [], freeDiskBytes: 1e12, osVersion: "test" });
let memory = 128;

beforeEach(() => {
  memory = 128;
  __resetSettingsForTests(); __resetChoicesForTests(); __resetPartChoicesForTests();
  __setChoicesDepsForTests({
    probe: async () => hw(memory),
    installPart: async (id) => ({ job: `job-${id}` }),
    installPin: async (pin) => ({ job: `pin-${pin.id}`, done: Promise.resolve() }),
    inspect: async () => { throw new Error("no link"); },
    parts: async (hardware) => { const { listParts } = await import("@/lib/partsList"); return (await listParts({ audience: "adult" }, hardware)).parts as StackPartView[]; },
    uninstallPart: async (id) => ({ component: id, freed_bytes: 0, removed: true } as never),
  });
  __setProfileDepsForTests({ probe: async () => hw(memory), install: async (pin) => ({ job: `job-${pin.id}`, done: Promise.resolve() }) });
});
afterEach(() => { __setChoicesDepsForTests(null); __setProfileDepsForTests(null); __resetSettingsForTests(); __resetChoicesForTests(); __resetPartChoicesForTests(); });

type Level = { tier: string; options: Array<{ model: string; fits: boolean }>; recommended: { model: string | null } };
type Cat = { id: string; tiers: Level[] };
async function view(gb: number): Promise<{ profile: string; categories: Cat[] }> {
  memory = gb;
  return await (await app.request("/stack/v1/choices", { method: "GET" })).json() as { profile: string; categories: Cat[] };
}
const table = (categories: Cat[], ids: string[]) => Object.fromEntries(categories.filter((item) => ids.includes(item.id)).map((item) => [item.id, Object.fromEntries(item.tiers.map((level) => [level.tier, level.recommended.model]))]));
const CATEGORIES = ["chat", "coding", "pictures", "video", "music", "voice", "stems", "wakeword"];

test("a 128 GB computer recommends the owner's lineup at every level", async () => {
  const read = await view(128);
  expect(read.profile).toBe("p128");
  expect(table(read.categories, CATEGORIES)).toEqual({
    chat: { reduced: "qwen3-4b-q4-k-m", standard: "qwen3-6-35b-a3b-huihui-abliterated-q4-k-m", boost: "qwen3.8-27b-ud-q4-k-m", max: "qwen3-8-flash-next-177b-huihui-abliterated-iq4-xs" },
    coding: { standard: "qwen3.8-27b-ud-q4-k-m", max: "qwen3-8-flash-next-177b-huihui-abliterated-iq4-xs" },
    pictures: { standard: "flux3-image-klein", boost: "flux3-image-klein", max: "flux3-image-klein" },
    video: { standard: "ltx-2-5-q8-distilled-mlx", boost: "ltx-2-5-q8-distilled-mlx", max: "ltx-2-5-bf16-distilled-mlx-max" },
    music: { standard: "ace-step-1-5-turbo", boost: null, max: null },
    voice: { reduced: "voxcpm2-4bit", standard: "voxcpm2-bf16" },
    stems: { standard: "htdemucs" },
    wakeword: { standard: "wakeword" },
  });
});

test("64 GB and 32 GB computers keep their own recommendations", async () => {
  expect(table((await view(64)).categories, CATEGORIES)).toEqual({
    chat: { reduced: "qwen3-4b-q4-k-m", standard: "qwen3-8b-instruct-q4-k-m", boost: "qwen3.8-27b-ud-q4-k-m", max: null },
    coding: { standard: "qwen3.8-27b-ud-q4-k-m", max: null },
    pictures: { standard: "flux3-image-klein", boost: "minimax-h3-image", max: null },
    video: {},
    music: { standard: "ace-step-1-5-turbo", boost: null, max: null },
    voice: { reduced: "chatterbox-nano", standard: "chatterbox-turbo-fp16" },
    stems: { standard: "htdemucs" },
    wakeword: { standard: "wakeword" },
  });
  expect(table((await view(32)).categories, ["chat", "pictures", "voice"])).toEqual({
    chat: { reduced: "qwen3-4b-q4-k-m", standard: "qwen3-8b-instruct-q4-k-m", boost: null, max: null },
    pictures: { standard: "minimax-h3-image", boost: "z-image-turbo", max: null },
    voice: { reduced: "pocket-tts-english", standard: "pocket-tts-english" },
  });
});

test("the models the 128 GB lineup dropped are still offered and still resolve as a Custom pick", async () => {
  const read = await view(128);
  const dropped: Array<[string, string, string]> = [
    ["voice", "standard", "chatterbox-turbo-fp16"], ["voice", "standard", "pocket-tts-english"], ["voice", "reduced", "pocket-tts-english"],
    ["chat", "standard", "qwen3-8b-instruct-q4-k-m"], ["chat", "standard", "qwen3-8-27b-huihui-abliterated-iq4-xs"],
    ["pictures", "standard", "flux2-klein-4b"], ["pictures", "standard", "minimax-h3-image"], ["pictures", "boost", "minimax-h3-image"], ["pictures", "max", "qwen-image-2512-q8"],
    ["video", "standard", "minimax-h3"],
  ];
  for (const [category, tier, model] of dropped) {
    const level = read.categories.find((item) => item.id === category)!.tiers.find((row) => row.tier === tier)!;
    expect({ category, tier, model, offered: level.options.some((option) => option.model === model && option.fits) }).toEqual({ category, tier, model, offered: true });
    // Reduced is the household pick's job (choiceResolver), not resolveTier's; the other levels resolve a named slot here.
    if (tier !== "reduced") expect(resolveTier({ category, tier: tier as "standard", profile: "p128", roomBytes: 110e9, slot: { model } })?.model).toBe(model);
  }
});

test("no model has two rows for the same profile, so no list offers it twice", () => {
  const seen = new Set<string>();
  for (const row of TIER_CANDIDATES) for (const profile of row.profiles) {
    const key = `${row.category}/${row.id}/${profile}`;
    expect(seen.has(key)).toBe(false);
    seen.add(key);
  }
});
