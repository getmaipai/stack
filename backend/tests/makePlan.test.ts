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
  const plan = planMake({ job: "clip", audience: "adult", part: "minimax-h3", description: "x", shape: "portrait", level: "standard", seconds: 5 }, parts());
  expect((plan as { refusal: { code: string } }).refusal.code).toBe("shape_not_served");
});
