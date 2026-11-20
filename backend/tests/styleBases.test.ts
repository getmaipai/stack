import { afterEach, beforeEach, expect, test } from "bun:test";
import { jobsCatalog } from "@/lib/jobsCatalog";
import { packFor } from "@/packs/loader";
import { clipBody, pictureBody } from "@/lib/makeDispatch";
import { planMake } from "@/lib/makePlan";
import { PART_DEFS } from "@/lib/partDefs";
import { __setPartsHardwareForTests } from "@/lib/partsList";
import { __resetPartChoicesForTests } from "@/lib/partChoices";
import type { HardwareInfo } from "@/lib/hardware";
import type { StackMakeRequest } from "@maipai/spec/stack/ts/stack-make.js";
import type { StackPartView } from "@maipai/spec/stack/ts/stack-part-view.js";

// MODELPACK-HOME-04, Stack side: the style bases a pack lists (data copied from Home's base table), served by the jobs catalog, and `styles[]` reaching the old routes.
const GB = 1_073_741_824;
const hw: HardwareInfo = { platform: "darwin", arch: "arm64", totalRamGb: 128, cpuCount: 16, isAppleSilicon: true, unifiedMemoryGb: 128, cudaDevices: [], freeDiskBytes: 1500 * GB, osVersion: "test" };
beforeEach(() => { __resetPartChoicesForTests(); __setPartsHardwareForTests(hw); });
afterEach(() => { __resetPartChoicesForTests(); __setPartsHardwareForTests(null); });

const VIDEO_PACKS = ["ltx-2-5-q8-distilled-mlx", "ltx-2-5-bf16-distilled-mlx-max"];
const LTX25 = { id: "ltx-2.5", label: "LTX 2.5", short: "LTX-2.5", media: "video" as const, civitai_labels: ["LTXV 2.5"], text_patterns: ["ltx[\\s_-]*(?:v|video)?[\\s_-]*2[._-]?5"], browse: ["ltx-2.5"], generic_labels: ["LTXV2"] };

test("each video pack lists the current base with Home's labels and patterns, and the retired older base with the base it is judged on", () => {
  for (const part of VIDEO_PACKS) {
    const bases = packFor(part)!.pack.style_bases!;
    expect(bases.find((b) => b.id === "ltx-2.5")).toEqual(LTX25);
    const retired = bases.find((b) => b.id === "ltx-2.3")!;
    expect(retired.retired).toMatchObject({ tested_on: "ltx-2.5", marks: { tested: expect.any(String), no_effect: expect.any(String) } });
    expect(retired.media).toBe("video");
    expect(retired.text_patterns!.map((p) => new RegExp(p).test("ltx video 2.3"))).toEqual([true]);
  }
});

test("a pattern a pack lists reads a base from a name the way Home's table does", () => {
  const [pattern] = packFor(VIDEO_PACKS[0]!)!.pack.style_bases!.find((b) => b.id === "ltx-2.5")!.text_patterns!;
  for (const name of ["LTX-2.5 cinematic", "ltxv_2_5 film", "ltx video 2.5", "LTX2.5"]) expect(new RegExp(pattern!).test(name.toLowerCase())).toBe(true);
  for (const name of ["ltx 2.3 film", "wan 2.2"]) expect(new RegExp(pattern!).test(name.toLowerCase())).toBe(false);
});

test("the adult catalog's clip entry serves the listed bases in full and leaves the retired one out", async () => {
  const clip = (await jobsCatalog("adult")).jobs.find((j) => j.job === "clip")!;
  expect(clip.styles.bases).toEqual([LTX25].map(({ browse: _browse, ...served }) => served));
});

test("a job whose pack lists no bases still answers an empty list", async () => {
  const song = (await jobsCatalog("adult")).jobs.find((j) => j.job === "song")!;
  expect(song.styles).toEqual({ bases: [], max: 0 });
});

const view = (id: string): StackPartView => { const d = PART_DEFS.find((p) => p.id === id)!; return { id, kind: d.kind, category: d.category, priority: d.priority, label: d.label, description: "", enabled: true, state: "ready", size_bytes: 1, fits: { standard: true, boost: true, max: true, reason: null }, can_install: false, install_block: null, can_uninstall: true, uninstall_block: null, licence_needed: false, required_by: [], update: null } as unknown as StackPartView; };
const plan = (request: StackMakeRequest, id: string) => { const p = planMake(request, [view(id)]); if (!p.ok) throw new Error("not planned"); return p; };

test("a clip's styles reach the video route as loras, by id; no styles sends none", () => {
  const request = { job: "clip", audience: "adult", description: "a barn", shape: "landscape", level: "max", seconds: 4, styles: ["lora-a", "lora-b"] } as StackMakeRequest;
  expect(clipBody(request as never, plan(request, "ltx-2-5-bf16-distilled-mlx-max"))).toMatchObject({ loras: [{ id: "lora-a" }, { id: "lora-b" }] });
  const bare = { ...request, styles: undefined } as StackMakeRequest;
  expect(clipBody(bare as never, plan(bare, "ltx-2-5-bf16-distilled-mlx-max"))).not.toHaveProperty("loras");
});

test("a picture's styles reach the picture route as loras, by id; no styles sends none", () => {
  const request = { job: "picture", audience: "adult", description: "a barn", shape: "square", level: "standard", styles: ["lora-a"] } as StackMakeRequest;
  expect(pictureBody(request as never, plan(request, "flux3-image-klein"))).toMatchObject({ loras: [{ id: "lora-a" }] });
  const bare = { ...request, styles: undefined } as StackMakeRequest;
  expect(pictureBody(bare as never, plan(bare, "flux3-image-klein"))).not.toHaveProperty("loras");
});
