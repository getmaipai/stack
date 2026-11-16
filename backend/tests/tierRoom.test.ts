// TIER-ROOM-01: the level room counts what Reduced frees, so Max and "fits ever" read true. Measured on the Studio (128 GB, p128)
// 2026-11-15: the candidates route reported a 41.5 GB room, the Max cap was that room, and the installed LTX-2.5 Max (61.5 GB) was
// refused as something this computer could never hold while the governor would have admitted it with chat on Reduced. Max is now
// sized from the Max room (resident room plus what Reduced frees) in the candidates route, the capabilities answer, fits_ever and
// canAdmit, through the one arithmetic in tierCapBytes("max").
import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit, fitsEverForTier, liveReducedFreedBytes, reducedRoomBytes, refreshMeasuredPeak, setMetalCapBytes, tierRoomBytes, type GovernorHandle } from "@/lib/governor";
import { setMachineTier } from "@/lib/supervisor";
import { tierCandidateLists, tierCapBytes, TIER_CAP_FRACTIONS, TIER_CANDIDATES } from "@/lib/tiers";

const GB = 1_000_000_000;
const LTX_MAX = "ltx-2-5-bf16-distilled-mlx-max";
const ORNITH = "ornith-1-5-122b-mlx-4bit";
const WAN = "fastwan2-2-ti2v-5b-mlx-bf16";

beforeEach(() => { __resetGovernorForTests(); __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 100 * GB, tier: "p128" }); });
afterEach(() => { setMachineTier(null); __resetGovernorForTests(); });

/** The p128 chat set as the fixtures load it: chat at its Standard peak, the judge, embeddings and the Standard voice, all reserved. */
async function loadChatSet(chatPeakBytes = 22_500_000_000): Promise<void> {
  const chat = await admit({ id: "chat", role: "chat", kind: "resident", class: "reserved", requestedBytes: chatPeakBytes }) as GovernorHandle;
  refreshMeasuredPeak(chat, chatPeakBytes);
  await admit({ id: "judge", role: "judge", kind: "resident", class: "reserved", requestedBytes: 5_700_000_000 });
  await admit({ id: "embed", role: "embed", kind: "resident", class: "reserved", requestedBytes: 1_200_000_000 });
  await admit({ id: "voice", role: "voice", kind: "resident", class: "reserved", requestedBytes: 4_580_000_000 });
}
const level = (lists: ReturnType<typeof tierCandidateLists>, tier: "standard" | "boost" | "max") => lists.find((item) => item.tier === tier)!;
const row = (lists: ReturnType<typeof tierCandidateLists>, tier: "standard" | "boost" | "max", id: string) => level(lists, tier).candidates.find((item) => item.id === id)!;

test("with the Standard chat set resident on p128 the Max room counts what Reduced frees, and LTX-2.5 Max and Ornith fit Max", async () => {
  await loadChatSet();
  const resident = tierRoomBytes();
  const max = tierRoomBytes("max");
  // The design (resource-tiers section 2 and 2a): about 72 GB for a Max job with chat resident, about 95 GB with chat on Reduced.
  expect(tierCapBytes("max", resident)).toBeGreaterThanOrEqual(72 * GB);
  expect(max).toBeGreaterThanOrEqual(85 * GB);
  expect(max).toBe(tierCapBytes("max", resident, reducedRoomBytes()));
  expect(reducedRoomBytes()).toBe(liveReducedFreedBytes());
  // Standard and Boost keep the resident room.
  const video = tierCandidateLists("video", "p128", resident, reducedRoomBytes());
  expect(level(video, "standard").capBytes).toBeCloseTo(TIER_CAP_FRACTIONS.standard * resident, -6);
  expect(level(video, "boost").capBytes).toBeCloseTo(TIER_CAP_FRACTIONS.boost * resident, -6);
  expect(level(video, "max").capBytes).toBe(max);
  expect(row(video, "max", LTX_MAX)).toMatchObject({ peakBytes: 61_500_000_000, fits: true, refusal: null });
  const chat = tierCandidateLists("chat", "p128", resident, reducedRoomBytes());
  expect(row(chat, "max", ORNITH)).toMatchObject({ peakBytes: 68_700_000_000, fits: true, refusal: null });
  // The governor gives the same answer for a household Max job, and a dev job is still sized from the resident room.
  expect(fitsEverForTier({ id: "ltx", role: "video", kind: "generator", requestedBytes: 61_500_000_000, tier: "max" })).toMatchObject({ fits: true, capBytes: max });
  expect(fitsEverForTier({ id: "ltx-dev", role: "video", kind: "generator", requestedBytes: 61_500_000_000, tier: "max", caller: "dev" }).capBytes).toBe(resident);
});

test("the Studio ledger of 2026-11-15: a 42 GB resident room, Wan refused at Standard with Boost or Max named, LTX-2.5 Max fits Max", async () => {
  // Chat measured at 39.7 GB and a model budget that leaves the resident room at the figure the route reported.
  await loadChatSet(39_700_000_000);
  setMetalCapBytes(93 * GB);
  const resident = tierRoomBytes();
  expect(resident).toBeGreaterThan(41 * GB);
  expect(resident).toBeLessThan(43 * GB);
  const freed = reducedRoomBytes();
  const video = tierCandidateLists("video", "p128", resident, freed);
  const wan = row(video, "standard", WAN);
  expect(wan.peakBytes).toBe(25_400_000_000);
  expect(wan.fits).toBe(false);
  expect(wan.refusal).toBe("This needs 25 GB. Standard keeps Home free, so it can't hold it. Use Boost or Max.");
  expect(row(video, "boost", WAN).fits).toBe(true);
  // Before TIER-ROOM-01 this read "This needs 62 GB and this computer can never hold it".
  expect(row(video, "max", LTX_MAX)).toMatchObject({ fits: true, refusal: null });
  expect(level(video, "max").capBytes).toBe(tierRoomBytes("max"));
  expect(tierRoomBytes("max")).toBeGreaterThanOrEqual(61_500_000_000);
});

test("the candidates route and the capabilities answer are built from the Max room", async () => {
  setMachineTier("p128");
  await loadChatSet(39_700_000_000);
  setMetalCapBytes(93 * GB);
  const capabilities = await (await app.request("/stack/v1/capabilities")).json() as { rows: Array<{ category: string; tier: string; fits_ever: boolean; needs_bytes: number | null; cap_bytes: number; model: string | null }> };
  const get = (category: string, tier: string) => capabilities.rows.find((item) => item.category === category && item.tier === tier)!;
  // Video's only Standard candidate (Wan) is above the Standard cap and its Max candidate fits the Max room: Standard false with the need stated, Max true.
  expect(get("video", "standard")).toMatchObject({ fits_ever: false, needs_bytes: 25_400_000_000, model: null });
  expect(get("video", "max")).toMatchObject({ fits_ever: true, needs_bytes: 61_500_000_000, model: LTX_MAX, cap_bytes: Math.round(tierRoomBytes("max")) });
  expect(get("chat", "max")).toMatchObject({ fits_ever: true, model: ORNITH });
  for (const category of ["chat", "image", "video", "music", "voice"]) {
    const caps = ["standard", "boost", "max"].map((tier) => get(category, tier).cap_bytes);
    expect(caps[0]!).toBeLessThanOrEqual(caps[1]!);
    expect(caps[1]!).toBeLessThanOrEqual(caps[2]!);
    // A level with a model fits it; a level that fits names a model: the answer never says "Yes" and "No" about the same model.
    for (const tier of ["standard", "boost", "max"]) { const item = get(category, tier); expect(item.fits_ever).toBe(item.model !== null); if (item.model) expect(item.needs_bytes!).toBeLessThanOrEqual(item.cap_bytes); }
  }
  const standard = tierCandidateLists("video", "p128", tierRoomBytes(), reducedRoomBytes());
  expect(level(standard, "max").capBytes).toBe(get("video", "max").cap_bytes);
});

test("fits is monotonic up the ladder for every candidate of every category, whatever the room and the Reduced saving", () => {
  for (const roomBytes of [20 * GB, 30 * GB, 41.5 * GB, 60 * GB, 74 * GB, 108 * GB]) {
    for (const freed of [0, 10 * GB, 18.6 * GB, 36 * GB]) {
      for (const category of ["chat", "pictures", "video", "music", "voice", "stems"] as const) {
        const lists = tierCandidateLists(category, "p128", roomBytes, freed);
        const ids = TIER_CANDIDATES.filter((item) => item.category === category && item.profiles.includes("p128") && item.tiers.some((tier) => tier !== "reduced")).map((item) => item.id);
        for (const id of ids) {
          const fits = (["standard", "boost", "max"] as const).map((tier) => row(lists, tier, id).fits);
          if (fits[0]) expect(fits[1]).toBe(true);
          if (fits[1]) expect(fits[2]).toBe(true);
          // "can never hold it" only when the peak is above the Max room with Reduced counted; otherwise the next level up is named.
          for (const tier of ["standard", "boost", "max"] as const) {
            const item = row(lists, tier, id);
            if (item.fits) continue;
            if (item.peakBytes > tierCapBytes("max", roomBytes, freed)) expect(item.refusal).toBe(`This needs ${Math.round(item.peakBytes / GB)} GB and this computer can never hold it.`);
            else expect(item.refusal).toMatch(/Use (Boost or Max|Max)\.$/);
          }
        }
      }
    }
  }
});

test("before chat has loaded the catalogue stands in for the ledger, and the Max room never exceeds the room with nothing reserved", async () => {
  // Nothing loaded: the resident room is already the whole budget, so Reduced can add nothing on top.
  const empty = tierRoomBytes();
  expect(reducedRoomBytes()).toBe(0);
  expect(tierRoomBytes("max")).toBe(empty);
  // A smaller budget with nothing loaded behaves the same way.
  setMetalCapBytes(75 * GB);
  expect(tierRoomBytes("max")).toBe(tierRoomBytes());
  setMetalCapBytes(null);
  // Chat on its Reduced model already: nothing more to free, the resident and Max rooms agree.
  const reduced = await admit({ id: "chat-reduced", role: "chat", kind: "resident", class: "reserved", requestedBytes: 5_700_000_000 }) as GovernorHandle;
  refreshMeasuredPeak(reduced, 5_700_000_000);
  expect(liveReducedFreedBytes()).toBe(0);
  expect(tierRoomBytes("max")).toBe(tierRoomBytes());
});
