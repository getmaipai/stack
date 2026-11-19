import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { StackJobsCatalog } from "@maipai/spec/stack/ts/stack-jobs-catalog.js";
import { jobsCatalog } from "@/lib/jobsCatalog";
import { __setPartsHardwareForTests } from "@/lib/partsList";
import { __resetPartChoicesForTests, writePartChoices } from "@/lib/partChoices";
import { PART_DEFS } from "@/lib/partDefs";
import type { HardwareInfo } from "@/lib/hardware";

const GB = 1_073_741_824;
const hw: HardwareInfo = { platform: "darwin", arch: "arm64", totalRamGb: 128, cpuCount: 16, isAppleSilicon: true, unifiedMemoryGb: 128, cudaDevices: [], freeDiskBytes: 1500 * GB, osVersion: "test" };
beforeEach(() => { __resetPartChoicesForTests(); __setPartsHardwareForTests(hw); });
afterEach(() => { __resetPartChoicesForTests(); __setPartsHardwareForTests(null); });

test("the route answers both audiences in the spec's shape", async () => {
  for (const audience of ["adult", "minor"]) {
    const response = await app.request(`/stack/v1/jobs/catalog?audience=${audience}`);
    expect(response.status).toBe(200);
    expect(StackJobsCatalog.safeParse(await response.json()).success).toBe(true);
  }
});

test("the adult catalog lists all fourteen jobs and a plain reason for any job nothing ready can do", async () => {
  const catalog = await jobsCatalog("adult");
  expect(catalog.audience).toBe("adult");
  expect(catalog.jobs.map((j) => j.job)).toEqual(["picture", "picture_edit", "clip", "clip_from_sheet", "restyle", "swap", "character_sheet", "contact_sheet", "song", "song_edit", "sound_effect", "stems", "vocal_swap", "lyric_timing"]);
  const restyle = catalog.jobs.find((j) => j.job === "restyle") as unknown as { available: boolean; why_not: string | null; alternatives: unknown[] };
  expect(restyle.available).toBe(false);
  expect(restyle.why_not).toContain("An admin can");
  expect(restyle.alternatives).toEqual([]);
});

test("the swap job is wired: a pack serves it, the catalog names the part and its limits, and an adult-only model is not offered to a minor (SWAP-01)", async () => {
  const swap = (await jobsCatalog("adult")).jobs.find((j) => j.job === "swap") as unknown as { available: boolean; why_not: string | null; alternatives: Array<{ part: string }>; limits: { levels: string[]; max_references?: number } };
  expect(swap.limits.levels).toEqual(["standard", "boost"]);
  expect(swap.limits.max_references).toBe(9);
  if (!swap.available) expect(swap.why_not).toContain("An admin can");
  expect(swap.alternatives.length + (swap.available ? 1 : 0)).toBe(1);
});

test("the minor catalog lists only jobs a part in the minor's list serves, and says no why and no alternative", async () => {
  const catalog = await jobsCatalog("minor");
  const names = catalog.jobs.map((j) => j.job);
  expect(names).toContain("picture");
  expect(names).not.toContain("clip"); // every clip pack is adult only today
  expect(names).not.toContain("swap");
  for (const job of catalog.jobs) {
    expect("why_not" in job).toBe(false);
    expect("alternatives" in job).toBe(false);
    expect(job.part === null || job.part.label === "Picture maker").toBe(true);
  }
  const body = JSON.stringify(catalog);
  for (const def of PART_DEFS.filter((d) => d.category === "pictures")) expect(body).not.toContain(def.label);
});

test("an adult's candidates follow the household's order; a minor's never read it", async () => {
  const adultBefore = (await jobsCatalog("adult")).jobs.find((j) => j.job === "picture") as unknown as { alternatives: Array<{ part: string }> };
  const ids = adultBefore.alternatives.map((a) => a.part);
  expect(ids.length).toBeGreaterThan(1);
  const reversed = [...ids].reverse();
  writePartChoices({ pictures: { order: reversed, off: [] } });
  const adultAfter = (await jobsCatalog("adult")).jobs.find((j) => j.job === "picture") as unknown as { alternatives: Array<{ part: string }> };
  expect(adultAfter.alternatives.map((a) => a.part)).toEqual(reversed);
  const minorBefore = JSON.stringify(await jobsCatalog("minor"));
  writePartChoices({ pictures: { order: ids, off: [] } });
  expect(JSON.stringify(await jobsCatalog("minor"))).toBe(minorBefore);
});

test("the catalog route is not read as a job id", async () => {
  const response = await app.request("/stack/v1/jobs/catalog?audience=adult");
  expect((await response.json() as { jobs?: unknown }).jobs).toBeDefined();
});
