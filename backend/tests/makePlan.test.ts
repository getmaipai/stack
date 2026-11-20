import { expect, test } from "bun:test";
import { planMake } from "@/lib/makePlan";
import { PART_DEFS } from "@/lib/partDefs";
import type { StackPartView } from "@maipai/spec/stack/ts/stack-part-view.js";
import type { StackMakeRequest } from "@maipai/spec/stack/ts/stack-make.js";

const view = (id: string, audience: "adult" | "minor" = "adult", over: Partial<StackPartView> = {}): StackPartView | null => {
  const def = PART_DEFS.find((d) => d.id === id)!;
  if (audience === "minor" && def.adultOnly) return null;
  return { id, kind: def.kind, category: def.category, priority: def.priority, label: audience === "adult" ? def.label : def.neutralLabel, description: "", enabled: true, state: "ready", size_bytes: 1, download_bytes: 1, percent: null,
    fits: { standard: true, boost: true, max: true, reason: null }, can_install: false, install_block: null, can_uninstall: true, uninstall_block: null, licence_needed: false, required_by: [], update: { available: false, version: null }, ...over } as StackPartView;
};
const PICS = ["flux3-image-klein", "minimax-h3-image"];
const VIDS = ["ltx-2-5-q8-distilled-mlx", "ltx-2-5-bf16-distilled-mlx-max", "minimax-h3"];
const parts = (audience: "adult" | "minor" = "adult", over: Record<string, Partial<StackPartView>> = {}) => [...PICS, ...VIDS].flatMap((id) => { const v = view(id, audience, over[id]); return v ? [v] : []; });
const pic = (over: Partial<Extract<StackMakeRequest, { job: "picture" }>> = {}): StackMakeRequest => ({ job: "picture", audience: "adult", description: "a cat", shape: "square", level: "standard", ...over });

test("a picture with no named part goes to the first ready part in order", () => {
  const plan = planMake(pic(), parts());
  expect(plan.ok && plan.serving.part.id).toBe("flux3-image-klein");
});
test("a part that is turned off is skipped", () => {
  const plan = planMake(pic(), parts("adult", { "flux3-image-klein": { enabled: false } }));
  expect(plan.ok && plan.serving.part.id).toBe("minimax-h3-image");
});
test("exact words need a text-capable part; with none ready nothing starts", () => {
  const plan = planMake(pic({ words: "OPEN" }), parts("adult", { "flux3-image-klein": { state: "missing" }, "minimax-h3-image": { state: "missing" } }));
  expect("unavailable" in plan && plan.unavailable).toContain("spell words");
});
test("a named part that does not serve the job gets not_on_this_model with the parts that do", () => {
  const plan = planMake({ job: "clip", audience: "adult", part: "minimax-h3-image", description: "a dog", shape: "landscape", level: "standard", seconds: 5 }, parts());
  expect(plan.ok).toBe(false);
  const refusal = (plan as { refusal: { code: string; line: string; alternatives: Array<{ part: string }> } }).refusal;
  expect(refusal.code).toBe("not_on_this_model");
  expect(refusal.line).toContain("Home can use");
  expect(refusal.alternatives.map((a) => a.part)).toContain("minimax-h3");
});
test("a minor's refusal names no model and offers none", () => {
  const plan = planMake({ job: "picture", audience: "minor", part: "ltx-2-5-q8-distilled-mlx", description: "a cat", shape: "square", level: "standard" }, parts("minor"));
  const refusal = (plan as { refusal: { code: string; line: string; alternatives: unknown[] } }).refusal;
  expect(refusal.code).toBe("not_on_this_model");
  expect(refusal.alternatives).toEqual([]);
  expect(refusal.line).not.toMatch(/ltx|minimax|flux/i);
});
test("a clip longer than the model's limit is too_long with the limit", () => {
  const plan = planMake({ job: "clip", audience: "adult", part: "ltx-2-5-q8-distilled-mlx", description: "x", shape: "landscape", level: "standard", seconds: 11 }, parts());
  expect(plan.ok).toBe(false);
  expect((plan as { refusal: { code: string; limit: number } }).refusal).toMatchObject({ code: "too_long", limit: 10 });
});
test("too many references is refused with the number", () => {
  const plan = planMake({ job: "picture_edit", audience: "adult", part: "minimax-h3-image", picture: "p1", description: "x", level: "standard", references: Array.from({ length: 17 }, (_, i) => `r${i}`) }, parts());
  expect((plan as { refusal: { code: string; limit: number } }).refusal).toMatchObject({ code: "too_many_references", limit: 16 });
});
test("a level the model does not serve is refused", () => {
  const plan = planMake({ job: "clip", audience: "adult", part: "minimax-h3", description: "x", shape: "landscape", level: "max", seconds: 5 }, parts());
  expect((plan as { refusal: { code: string } }).refusal.code).toBe("level_not_served");
});
test("a shape the model does not serve is refused", () => {
  // VF-CAPS-01: H3 makes tall clips (480x864) as the route always accepted, so its pack lists portrait; square is the shape it does not serve.
  const plan = planMake({ job: "clip", audience: "adult", part: "minimax-h3", description: "x", shape: "square", level: "standard", seconds: 5 }, parts());
  expect((plan as { refusal: { code: string } }).refusal.code).toBe("shape_not_served");
  const tall = planMake({ job: "clip", audience: "adult", part: "minimax-h3", description: "x", shape: "portrait", level: "standard", seconds: 5 }, parts());
  expect(tall.ok).toBe(true);
});

test("a song with no level is planned at the first level its model serves, and a long one is refused in songs", () => {
  const request = { job: "song", audience: "adult", description: "a calm tune", seconds: 60 } as never;
  const planned = planMake(request, [view("ace-step-1-5-turbo")!]);
  expect(planned.ok && planned.level).toBe("standard");
  const boostOnly = planMake(request, [view("ace-step-1-5-xl-turbo-bf16")!]);
  expect(boostOnly.ok && boostOnly.level).toBe("boost");
  const tooLong = planMake({ ...(request as object), seconds: 300 } as never, [view("ace-step-1-5-turbo")!]);
  expect(tooLong.ok).toBe(false);
  if (!tooLong.ok && "refusal" in tooLong) expect(tooLong.refusal).toMatchObject({ code: "too_long", limit: 120 });
});

const SONG_PARTS = ["ace-step-1-5-turbo", "ace-step-1-5-xl-turbo-bf16", "ace-step-1-5-xl-sft-bf16"];
const songParts = (over: Record<string, Partial<StackPartView>> = {}, audience: "adult" | "minor" = "adult") => SONG_PARTS.flatMap((id) => { const v = view(id, audience, over[id]); return v ? [v] : []; });
const song = (level?: "standard" | "boost" | "max", audience: "adult" | "minor" = "adult"): StackMakeRequest => ({ job: "song", audience, description: "a calm tune", seconds: 60, ...(level ? { level } : {}) }) as StackMakeRequest;

test("a song that names a level is planned among the parts that serve it, not refused because the standard part is first", () => {
  for (const [level, part] of [["standard", "ace-step-1-5-turbo"], ["boost", "ace-step-1-5-xl-turbo-bf16"], ["max", "ace-step-1-5-xl-sft-bf16"]] as const) {
    const plan = planMake(song(level), songParts());
    expect(plan.ok && [plan.serving.part.id, plan.level]).toEqual([part, level]);
  }
  const noLevel = planMake(song(), songParts());
  expect(noLevel.ok && noLevel.serving.part.id).toBe("ace-step-1-5-turbo");
});

test("a song edit that names a level is planned among the parts that serve it too", () => {
  const plan = planMake({ job: "song_edit", audience: "adult", song: "/v1/audio/music/s1/file", change: { kind: "extend", add_seconds: 20 }, level: "boost" }, songParts());
  expect(plan.ok && plan.serving.part.id).toBe("ace-step-1-5-xl-turbo-bf16");
});

test("a level whose part is not installed or ready is answered in the Stack's words, and a minor's line names no model", () => {
  const adult = planMake(song("max"), songParts({ "ace-step-1-5-xl-sft-bf16": { state: "missing" } }));
  expect(!adult.ok && "unavailable" in adult && adult.unavailable).toBe("No model that can make songs at max quality is turned on and ready. An admin can turn one on or add one in Settings, AI and models.");
  const minor = planMake(song("max", "minor"), songParts({ "ace-step-1-5-xl-sft-bf16": { state: "missing" } }, "minor"));
  const line = !minor.ok && "unavailable" in minor ? minor.unavailable : "";
  expect(line).toBe("No model that can make songs at max quality is turned on and ready.");
  expect(line).not.toMatch(/ace|xl|sft/i);
});

test("a level no part's pack serves stays level_not_served", () => {
  const plan = planMake({ job: "clip", audience: "adult", description: "x", shape: "landscape", level: "max", seconds: 5 }, parts("adult", { "ltx-2-5-bf16-distilled-mlx-max": { state: "missing" } }).filter((p) => p.id !== "ltx-2-5-bf16-distilled-mlx-max"));
  expect(!plan.ok && "refusal" in plan && plan.refusal.code).toBe("level_not_served");
});
