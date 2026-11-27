import { afterEach, expect, test } from "bun:test";
import { setBudgetPercent, budgetPercent, proposeProfile } from "@/profiles";
import { buildInstallPlan } from "@/lib/installPlan";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, defaultModelBudgetBytes, setGovernorMemorySettings, tierRoomBytes } from "@/lib/governor";
import { reserveBytes } from "@/lib/memoryState";
import { tierCandidateLists } from "@/lib/tiers";
import { __resetSettingsForTests, readSettings, removeRetiredSettingKeys, settingValues, updateSettings } from "@/settings";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { like } from "drizzle-orm";
import type { HardwareInfo } from "@/lib/hardware";
import type { ProfileTier } from "@/profiles";

const GB = 1_073_741_824;
const hw = (over: { unifiedMemoryGb: number; totalRamGb: number }): HardwareInfo => ({ platform: "darwin", arch: "arm64", cpuCount: 12, isAppleSilicon: true, freeDiskBytes: 0, totalDiskBytes: 0, osVersion: "test", cudaDevices: [], ...over });

afterEach(() => { setBudgetPercent(100); setGovernorMemorySettings({ budgetPercent: 100 }); __resetGovernorForTests(); __resetSettingsForTests(); });

test("half of 128 GB resolves and plans like 64 GB", () => {
  setBudgetPercent(50);
  const large = hw({ unifiedMemoryGb: 128, totalRamGb: 128 });
  setGovernorMemorySettings({ budgetPercent: 50 });
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, tier: "p64" });
  const small = hw({ unifiedMemoryGb: 64, totalRamGb: 64 });
  expect(proposeProfile(large)?.id).toBe("p64");
  setBudgetPercent(100);
  expect(proposeProfile(small)?.id).toBe("p64");
  setBudgetPercent(50);
  const a = buildInstallPlan(large, { installedIds: [] });
  setBudgetPercent(100);
  const b = buildInstallPlan(small, { installedIds: [] });
  expect({ tier: a.tier, models: a.models.map((m) => m.id), total_bytes: a.total_bytes }).toEqual({ tier: b.tier, models: b.models.map((m) => m.id), total_bytes: b.total_bytes });
  setGovernorMemorySettings({ budgetPercent: 50 }); __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, tier: "p64" });
  const roomA = tierRoomBytes();
  setGovernorMemorySettings({ budgetPercent: 100 }); __setGovernorTuningForTestsOnly({ totalMemoryBytes: 64 * GB, tier: "p64" });
  const roomB = tierRoomBytes();
  // Each computer is sized at its own budget: the 128 GB one at 50 percent, the 64 GB one at 100.
  setBudgetPercent(50); const pa = proposeProfile(large)!;
  setBudgetPercent(100); const pb = proposeProfile(small)!;
  expect(pa.id).toBe("p64");
  // The same candidates at every level; with the same room they fit the same way. The 50 percent room of the larger computer is
  // about 4 GB larger (60.1 against 55.8 GB here), so a model right at the edge can fit there and not on the 64 GB one: FLUX 3
  // Klein's measured 33.9 GB (FLUX3-PEAK-01) is under 0.6 of 60.1 GB and over 0.6 of 55.8 GB.
  expect(roomA).toBeGreaterThan(roomB);
  const ids = (results: ReturnType<typeof candidateResults>) => results.map((list) => ({ tier: list.tier, ids: list.candidates.map(({ id }) => id) }));
  for (const category of ["chat", "pictures", "video", "music"] as const) {
    expect(ids(candidateResults(category, pa.id, roomA, 0, "p64"))).toEqual(ids(candidateResults(category, pb.id, roomB, 0, "p64")));
    expect(candidateResults(category, pa.id, roomB, 0, "p64")).toEqual(candidateResults(category, pb.id, roomB, 0, "p64"));
  }
});

test("100 percent preserves the default cap and half budget reserves the other half", () => {
  setBudgetPercent(100); setGovernorMemorySettings({ budgetPercent: 100 });
  expect(proposeProfile(hw({ unifiedMemoryGb: 128, totalRamGb: 128 }))?.id).toBe("p128");
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, tier: "p128" });
  expect(defaultModelBudgetBytes()).toBe(120 * GB);
  expect(reserveBytes(128 * GB)).toBeCloseTo(10.24 * GB, -6);
  setBudgetPercent(50); setGovernorMemorySettings({ budgetPercent: 50 });
  expect(reserveBytes(128 * GB)).toBe(64 * GB);
  expect(defaultModelBudgetBytes()).toBe(56 * GB);
});

test("setting updates profiles and governor; retired rows are deleted without a new value", async () => {
  __resetSettingsForTests();
  expect(SET_KEYS()).toContain("stack.memory.budget_percent");
  expect(SET_KEYS()).not.toContain("stack.memory.model_budget_bytes");
  expect(SET_KEYS()).not.toContain("stack.memory.reserve_gb");
  updateSettings({ "stack.memory.budget_percent": 50 });
  expect(settingValues()["stack.memory.budget_percent"]).toBe(50);
  expect(budgetPercent()).toBe(50);
  expect(defaultModelBudgetBytes()).toBe(56 * GB);
  db.delete(meta).where(like(meta.key, "settings.stack.memory.budget_percent.%")).run();
  for (const key of ["settings.stack.memory.model_budget_bytes.in_effect", "settings.stack.memory.reserve_gb.in_effect", "settings.modelBudgetBytes.in_effect"]) db.insert(meta).values({ key, value: "4" }).run();
  expect(removeRetiredSettingKeys()).toBe(3);
  expect(db.select().from(meta).all().map((row) => row.key).filter((key) => key.startsWith("settings.stack.memory.budget_percent."))).toEqual([]);
});

function SET_KEYS(): string[] { return readSettings().map((s) => s.key); }
function candidateResults(category: "chat" | "pictures" | "video" | "music", profile: ProfileTier["id"], room: number, reducedFreed: number, sourceProfile: ProfileTier["id"]) {
  const ladder = tierCandidateLists(category, profile, room, reducedFreed);
  const catalog = tierCandidateLists(category, sourceProfile, room, reducedFreed);
  const ids = new Set(catalog.flatMap((list) => list.candidates.map(({ id }) => id)));
  return ladder.map((list) => ({ tier: list.tier, candidates: list.candidates.filter(({ id }) => ids.has(id)).map(({ id, fits }) => ({ id, fits })) }));
}
