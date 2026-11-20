import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { StackMakeRequest } from "@maipai/spec/stack/ts/stack-make.js";
import { fillCompanionRecipe } from "@/lib/recipe";
import { planClipRoute } from "@/lib/clipRoute";
import { dispatchClip } from "@/lib/makeDispatch";
import { rowsForJob } from "@/video/caps";
import { packFor } from "@/packs/loader";
import { jobsCatalog } from "@/lib/jobsCatalog";

const fixturePath = new URL("./fixtures/companion-take-golden.json", import.meta.url).pathname;
type Golden = { entries: Array<{ kind: "pack_take" | "pack_gesture"; description: string; key_colour: "green" | "magenta"; prompt: string; negative_prompt: string }>; outputs_sha256: string };
const golden = (): Golden => JSON.parse(readFileSync(fixturePath, "utf8")) as Golden;
const recipe = (part: string): string => {
  const pack = packFor(part);
  const text = pack?.recipes["recipes/companion_take.md"];
  if (!text) throw new Error(`missing companion recipe for ${part}`);
  return text;
};

test("companion recipe outputs match every pack entry exactly", () => {
  const outputs: string[] = [];
  for (const part of ["ltx-2-5-q8-distilled-mlx", "ltx-2-5-bf16-distilled-mlx-max", "minimax-h3"]) {
    for (const entry of golden().entries) {
      const frame = entry.kind === "pack_take" ? "state" : "gesture";
      const filled = fillCompanionRecipe(recipe(part), { description: entry.description, key_colour: entry.key_colour, frame });
      expect(filled.prompt).toBe(entry.prompt);
      expect(filled.negative).toBe(entry.negative_prompt);
    }
  }
});

// UPDATE_GOLDEN=1 bun test tests/companionTake.test.ts rewrites outputs_sha256; review and commit that diff with recipe edits.
test("recipe output hash changes only with an updated golden file", () => {
  const data = golden();
  const outputs = ["ltx-2-5-q8-distilled-mlx", "ltx-2-5-bf16-distilled-mlx-max", "minimax-h3"].flatMap((part) => data.entries.map((entry) => {
    const frame = entry.kind === "pack_take" ? "state" : "gesture";
    const filled = fillCompanionRecipe(recipe(part), { description: entry.description, key_colour: entry.key_colour, frame });
    return `${part}\n${entry.kind}\n${filled.prompt}\n${filled.negative}`;
  })).join("\n");
  const digest = createHash("sha256").update(outputs).digest("hex");
  if (process.env.UPDATE_GOLDEN === "1") { data.outputs_sha256 = digest; writeFileSync(fixturePath, `${JSON.stringify(data, null, 2)}\n`); }
  else expect(digest).toBe(data.outputs_sha256);
});

test("companion take planner requires recipe, start picture, adult audience and available row", () => {
  const rows = rowsForJob("ltx-2-5-q8-distilled-mlx", "clip");
  const req = { job: "clip", operation: "companion_take", audience: "adult", description: "the person nods", key_colour: "green", take_frame: "state", loop: false, start_picture: "p", shape: "landscape", level: "standard", seconds: 5 } as const;
  expect(planClipRoute(req, rows, true)).toMatchObject({ ok: true, route: "start_picture", operation: "companion_take" });
  expect(planClipRoute({ ...req, start_picture: undefined }, rows, true)).toMatchObject({ ok: false, refusal: { code: "input_not_supported", line: expect.stringContaining("start picture") } });
  expect(planClipRoute({ ...req, audience: "minor" }, rows, true)).toEqual({ ok: false, refusal: { code: "input_not_supported", line: "Companion takes are not available for this viewer yet." } });
  expect(planClipRoute(req, rows, false)).toMatchObject({ ok: false, refusal: { code: "input_not_supported" } });
});

test("companion loop uses an end picture only when the row supports one", () => {
  const row = rowsForJob("ltx-2-5-q8-distilled-mlx", "clip").find((item) => item.operation === "clip_start_end_pictures")!;
  const req = { job: "clip", operation: "companion_take", audience: "adult", description: "the person nods", key_colour: "green", take_frame: "state", loop: true, start_picture: "p", shape: "landscape", level: "standard", seconds: 5 } as const;
  const start = rowsForJob("ltx-2-5-q8-distilled-mlx", "clip").find((item) => item.operation === "clip_start_picture")!;
  expect(planClipRoute(req, [start, row], true)).toMatchObject({ ok: true, route: "start_end_pictures" });
  expect(planClipRoute(req, [start, { ...row, inputs: { ...row.inputs, end_picture: false } }], true)).toMatchObject({ ok: true, route: "start_picture", reason: expect.stringContaining("no end-picture row") });
});

test("companion dispatch fills recipe and sends route and negative prompt for engines that take it", async () => {
  let sent: Record<string, unknown> = {};
  const part = "ltx-2-5-q8-distilled-mlx";
  const req = { job: "clip", operation: "companion_take", audience: "adult", description: "the person nods", key_colour: "green", take_frame: "gesture", loop: false, start_picture: "p", shape: "landscape", level: "standard", seconds: 5 } as const;
  const pack = packFor(part)!;
  const plan = { ok: true, serving: { pack, job: pack.pack.jobs[0], part: { id: part } }, level: "standard", shape: "landscape", seconds: 5 } as never;
  const result = await dispatchClip(req, plan, async (_path, body) => { sent = body as Record<string, unknown>; return { status: 200, json: { job: "j", data: [] } }; }, async () => ({ bytes: new Uint8Array([1]), type: "image/png" }));
  expect(result.status).toBe(200);
  expect(sent.prompt).toContain("Static locked headshot");
  expect(sent.prompt).toContain("plain solid green background");
  expect(sent.negative_prompt).toBeTruthy();
  expect(sent.route).toMatchObject({ name: "companion_take" });
});

test("clip schema rejects caller wording keys and catalog fields come from spec", async () => {
  const base = { job: "clip", operation: "companion_take", audience: "adult", description: "x", shape: "landscape", level: "standard", seconds: 5 };
  expect(StackMakeRequest.safeParse({ ...base, key_colour: "green", take_frame: "state", loop: true, verbatim: true }).success).toBe(false);
  expect(StackMakeRequest.safeParse({ ...base, negative_words: "x" }).success).toBe(false);
  expect(StackMakeRequest.safeParse({ ...base, key_colour: "blue" }).success).toBe(false);
  const catalog = await jobsCatalog("adult");
  const fields = catalog.jobs.find((job) => job.job === "clip")?.request_fields ?? [];
  expect(fields).toEqual(expect.arrayContaining(["operation", "key_colour", "take_frame", "loop"]));
});
