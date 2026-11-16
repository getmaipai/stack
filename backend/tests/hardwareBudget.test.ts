import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, tierRoomBytes } from "@/lib/governor";
import { setMachineTier } from "@/lib/supervisor";
import { hardwareRoutes } from "@/routes/hardware";
import { budgetSlots } from "@/lib/tiers";

const GB = 1_000_000_000;
beforeEach(() => { __resetGovernorForTests(); __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 20 * GB, tier: "p128" }); setMachineTier("p128"); });
afterEach(() => { __resetGovernorForTests(); setMachineTier(null); });

describe("hardware budget (TIER-BUDGET-01)", () => {
  test("lists every level with a model from the tier room, not from memory free now", async () => {
    const res = await hardwareRoutes.request("/budget");
    expect(res.status).toBe(200);
    const body = await res.json() as { free_now_bytes: number; room_bytes: number; margin_bytes: number; reading_degraded: boolean; profile: string | null; slots: Array<{ category: string; tier: string; model: string | null; peak_bytes: number | null; basis: string | null; fits_ever: boolean }> };
    expect(body.free_now_bytes).toBe(20 * GB);
    expect(body.room_bytes).toBe(Math.round(tierRoomBytes()));
    expect(body.room_bytes).toBeGreaterThan(20 * GB);
    expect(body.profile).toBe("p128");
    expect(typeof body.margin_bytes).toBe("number");
    expect(typeof body.reading_degraded).toBe("boolean");
    const withPeak = body.slots.filter((row) => typeof row.peak_bytes === "number").map((row) => `${row.category}:${row.tier}`);
    for (const key of ["chat:reduced", "chat:standard", "chat:boost", "chat:max", "pictures:standard", "pictures:boost", "pictures:max", "video:standard", "video:max", "music:standard", "voice:reduced", "voice:standard"]) expect(withPeak).toContain(key);
    for (const row of body.slots.filter((item) => item.peak_bytes !== null)) expect(row.basis === "measured" || row.basis === "estimated").toBe(true);
  });

  test("an empty level is listed with nulls, never omitted", () => {
    const slots = budgetSlots("p128", 72 * GB);
    expect(slots.find((row) => row.category === "video" && row.tier === "boost")).toMatchObject({ model: null, peak_bytes: null, basis: null, fits_ever: false });
    expect(slots.find((row) => row.category === "music" && row.tier === "max")).toMatchObject({ model: null, peak_bytes: null });
  });

  test("fits_ever compares the peak with the level's cap", () => {
    const small = budgetSlots("p128", 40 * GB);
    expect(small.find((row) => row.category === "chat" && row.tier === "standard")?.fits_ever).toBe(true);
    expect(small.find((row) => row.category === "chat" && row.tier === "max")).toMatchObject({ peak_bytes: 68_700_000_000, fits_ever: false });
  });
});
