// VF-TAKES-01: retake, extend and "another take" on the generic door. A fake forward records what reaches the legacy route; no model runs.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { dispatchClip } from "@/lib/makeDispatch";
import { planMake } from "@/lib/makePlan";
import { planClipRoute } from "@/lib/clipRoute";
import { rowsForJob } from "@/video/caps";
import { PART_DEFS } from "@/lib/partDefs";
import { __resetGovernorForTests, setMetalCapBytes, tierRoomBytes } from "@/lib/governor";
import { setMachineTier } from "@/lib/supervisor";
import { __setPartsHardwareForTests } from "@/lib/partsList";
import { __resetPartChoicesForTests } from "@/lib/partChoices";
import { StackMakeRequest } from "@maipai/spec/stack/ts/stack-make.js";
import type { StackPartView } from "@maipai/spec/stack/ts/stack-part-view.js";
import type { HardwareInfo } from "@/lib/hardware";

const GB = 1_073_741_824;
const hw: HardwareInfo = { platform: "darwin", arch: "arm64", totalRamGb: 128, cpuCount: 16, isAppleSilicon: true, unifiedMemoryGb: 128, cudaDevices: [], freeDiskBytes: 1500 * GB, osVersion: "test" };
beforeEach(() => { __resetPartChoicesForTests(); __setPartsHardwareForTests(hw); });
afterEach(() => { __resetPartChoicesForTests(); __setPartsHardwareForTests(null); });
const ready = (id: string): StackPartView => { const d = PART_DEFS.find((p) => p.id === id)!; return { id, kind: d.kind, category: d.category, priority: d.priority, label: d.label, description: "", enabled: true, state: "ready", size_bytes: 1, download_bytes: 1, percent: null, fits: { standard: true, boost: true, max: true, reason: null }, can_install: false, install_block: null, can_uninstall: true, uninstall_block: null, licence_needed: false, required_by: [], update: { available: false, version: null } } as StackPartView; };
type Clip = Extract<StackMakeRequest, { job: "clip" }>;
const clip = (over: Record<string, unknown> = {}): Clip => ({ job: "clip", audience: "adult", description: "the dog runs on", shape: "landscape", level: "max", seconds: 3, ...over }) as Clip;
const SOURCE = { role: "edit_source", file: "/v1/videos/generations/nojob/video.mp4" };
const max = rowsForJob("ltx-2-5-bf16-distilled-mlx-max", "clip");

test("retake_from and extend are planned only where the pack's row is available: Max LTX serves them; Standard, Boost and H3 answer a typed refusal with a plain line", () => {
  expect(planClipRoute(clip({ operation: "retake_from", at_seconds: 2, inputs: [SOURCE] }), max)).toMatchObject({ ok: true, operation: "retake" });
  expect(planClipRoute(clip({ operation: "extend", inputs: [SOURCE] }), max)).toMatchObject({ ok: true, operation: "extend" });
  for (const [part, level] of [["ltx-2-5-q8-distilled-mlx", "standard"], ["ltx-2-5-q8-distilled-mlx", "boost"], ["minimax-h3", "standard"]] as const) {
    const planned = planClipRoute(clip({ level, operation: "extend", inputs: [SOURCE] }), rowsForJob(part, "clip"));
    expect(planned, `${part} ${level}`).toMatchObject({ ok: false, refusal: { code: "input_not_supported" } });
    if (!planned.ok) expect("line" in planned.refusal && planned.refusal.line.length).toBeGreaterThan(10);
  }
});

test("the spec parses the take shapes", () => {
  expect(StackMakeRequest.safeParse(clip({ operation: "extend", inputs: [SOURCE] })).success).toBe(true);
  expect(StackMakeRequest.safeParse(clip({ take_of: "job1", seed: 9 })).success).toBe(true);
  expect(StackMakeRequest.safeParse(clip({ operation: "rewind" })).success).toBe(false);
});

test("an unreadable source clip is refused with not_available, never dropped, and nothing is forwarded", async () => {
  const plan = planMake(clip({ operation: "extend", inputs: [SOURCE] }), [ready("ltx-2-5-bf16-distilled-mlx-max")]);
  if (!plan.ok) throw new Error("not planned");
  let forwarded = 0;
  const result = await dispatchClip(clip({ operation: "extend", inputs: [SOURCE] }), plan, async () => { forwarded += 1; return { status: 200, json: {} }; }, async () => null);
  expect(result).toMatchObject({ status: 409, body: { code: "not_available" } });
  expect(forwarded).toBe(0);
});

test("another take sends the same request to the same door with take_of and the request's seed; the legacy fields stay untouched", async () => {
  const plan = planMake(clip({ level: "standard", take_of: "job1", seed: 77 }), [ready("ltx-2-5-q8-distilled-mlx")]);
  if (!plan.ok) throw new Error("not planned");
  const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
  const result = await dispatchClip(clip({ level: "standard", take_of: "job1", seed: 77 }), plan, async (path, body) => { sent.push({ path, body: body as Record<string, unknown> }); return { status: 200, json: { job: "job2", data: [{ url: "/v1/videos/generations/job2/video.mp4", seconds: 3, audio: true }], notes: [] } }; }, async () => null);
  expect(result.status).toBe(200);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.path).toBe("/v1/videos/generations");
  expect(sent[0]!.body).toMatchObject({ take_of: "job1", seed: 77, model: "ltx-2-5-q8-distilled-mlx" });
  expect((result.body as { id: string }).id).toBe("job2");
});

test("a plain request without take_of sends no take_of and no source fields (the old outcome)", async () => {
  const plan = planMake(clip({ level: "standard" }), [ready("ltx-2-5-q8-distilled-mlx")]);
  if (!plan.ok) throw new Error("not planned");
  let body: Record<string, unknown> = {};
  await dispatchClip(clip({ level: "standard" }), plan, async (_path, sent) => { body = sent as Record<string, unknown>; return { status: 200, json: { job: "j", data: [] } }; }, async () => null);
  expect(body.take_of).toBeUndefined();
  expect(body.source_video).toBeUndefined();
  expect(body.extend_seconds).toBeUndefined();
});

test("a film shot is planned on a Max pack with a film-shot row, refused with a plain line elsewhere, and carries no size field in the request", () => {
  expect(planClipRoute(clip({ operation: "clip_film_shot" }), max)).toMatchObject({ ok: true, filmShot: true });
  for (const [part, level] of [["ltx-2-5-q8-distilled-mlx", "standard"], ["minimax-h3", "standard"]] as const) {
    expect(planClipRoute(clip({ level, operation: "clip_film_shot" }), rowsForJob(part, "clip")), part).toMatchObject({ ok: false, refusal: { code: "input_not_supported" } });
  }
  expect(StackMakeRequest.safeParse(clip({ operation: "clip_film_shot" })).success).toBe(true);
  expect(StackMakeRequest.safeParse(clip({ operation: "clip_film_shot", size: "1920x1088" })).success).toBe(false);
});

test("a film shot goes to the legacy door at full HD only when the Max room holds it and the clip is within full HD's seconds; otherwise at the standard Max size, and the route reason says which", async () => {
  const plan = planMake(clip({ operation: "clip_film_shot", seconds: 5 }), [ready("ltx-2-5-bf16-distilled-mlx-max")]);
  if (!plan.ok) throw new Error("not planned");
  const run = async (seconds: number) => {
    let body: Record<string, unknown> = {};
    await dispatchClip(clip({ operation: "clip_film_shot", seconds }), plan, async (_path, sent) => { body = sent as Record<string, unknown>; return { status: 200, json: { job: "j", data: [] } }; }, async () => null);
    return body as { size?: string; route?: { name: string; reason: string } };
  };
  const hd = await run(5);
  expect(hd.size).toBe("1920x1088");
  expect(hd.route?.reason).toContain("full HD because this computer can hold it");
  const long = await run(8);
  expect(long.size).toBe("1024x576");
  expect(long.route?.reason).toContain("at most 5 seconds");
});

test("a film shot falls back to the standard Max size, never full HD, when the Max room cannot hold full HD (the receipt reason says so)", async () => {
  setMachineTier("p128"); setMetalCapBytes(60 * GB);
  try {
    expect(tierRoomBytes("max")).toBeLessThan(77_700_000_000);
    const plan = planMake(clip({ operation: "clip_film_shot", seconds: 5 }), [ready("ltx-2-5-bf16-distilled-mlx-max")]);
    if (!plan.ok) throw new Error("not planned");
    let body: Record<string, unknown> = {};
    await dispatchClip(clip({ operation: "clip_film_shot", seconds: 5 }), plan, async (_path, sent) => { body = sent as Record<string, unknown>; return { status: 200, json: { job: "j", data: [] } }; }, async () => null);
    expect((body as { size?: string }).size).toBe("1024x576");
    expect((body as { route?: { reason: string } }).route?.reason).toContain("cannot hold full HD right now");
  } finally { setMachineTier(null); __resetGovernorForTests(); }
});
