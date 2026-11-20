import { expect, test } from "bun:test";
import { planClipRoute } from "@/lib/clipRoute";
import { rowsForJob, videoOperationRows } from "@/video/caps";
import { StackMakeRefusal, StackMakeResult } from "@maipai/spec/stack/ts/stack-make.js";
import { StackVideoReceipt } from "@maipai/spec/stack/ts/stack-video-receipt.js";

const req = (over: Record<string, unknown> = {}) => ({ job: "clip", audience: "adult", description: "a person", shape: "landscape", level: "standard", seconds: 5, ...over }) as never;
const ltx = rowsForJob("ltx-2-5-q8-distilled-mlx", "clip");
const h3 = rowsForJob("minimax-h3", "clip");
const row = (rows: typeof ltx, op: string) => rows.find((r) => r.operation === op)!;

test("plans words, start, and start plus end from available operation rows", () => {
  expect(planClipRoute(req(), ltx)).toMatchObject({ ok: true, route: "words", operation: "clip_text" });
  expect(planClipRoute(req({ start_picture: "p" }), ltx)).toMatchObject({ ok: true, route: "start_picture", operation: "clip_start_picture" });
  expect(planClipRoute(req({ start_picture: "p", end_picture: "q" }), ltx)).toMatchObject({ ok: true, route: "start_end_pictures", operation: "clip_start_end_pictures" });
});

test("identity with a start uses the start and records the identity input outside route choice", () => {
  expect(planClipRoute(req({ start_picture: "p", inputs: [{ role: "identity", file: "i" }] }), ltx)).toMatchObject({ ok: true, route: "start_picture", identityUsed: 0, reason: expect.stringContaining("start picture") });
});

test("identity without a references capability needs a start picture for adults and minors", () => {
  for (const audience of ["adult", "minor"]) expect(planClipRoute(req({ audience, inputs: [{ role: "identity", file: "i" }] }), ltx)).toMatchObject({ ok: false, refusal: { code: "needs_start_picture", line: "This model holds a person only from a first picture. Make one from the person's picture and send it as the start picture." } });
});

test("a declared references row uses one identity by default and names references set aside", () => {
  const { unavailable_reason: _reason, ...textRow } = row(ltx, "clip_text");
  const refs = { ...textRow, operation: "clip_references" as const, available: true, inputs: { ...textRow.inputs, references: 3 } };
  expect(planClipRoute(req({ inputs: [{ role: "identity", file: "1" }, { role: "identity", file: "2" }] }), [...ltx.filter((r) => r.operation !== "clip_references"), refs])).toMatchObject({ ok: true, route: "references", identityUsed: 1, reason: expect.stringContaining("1 identity picture set aside") });
});

test("unsupported voice, wardrobe and edit source are refused", () => {
  for (const role of ["voice_reference", "wardrobe", "edit_source"]) expect(planClipRoute(req({ inputs: [{ role, file: "x" }] }), h3)).toMatchObject({ ok: false, refusal: { code: "input_not_supported" } });
});

test("every available clip operation row accepts the input shape it advertises", () => {
  for (const r of videoOperationRows().filter((x) => x.available && x.operation.startsWith("clip_") && x.operation !== "clip_film_shot")) {
    const inputs = [ ...(r.inputs.references ? [{ role: "identity", file: "i" }] : []) ];
    const planned = planClipRoute(req({ level: r.level, ...(r.inputs.start_picture ? { start_picture: "p" } : {}), ...(r.inputs.end_picture ? { end_picture: "e" } : {}), inputs }), [r]);
    expect(planned.ok, `${r.operation}/${r.level}`).toBe(true);
  }
});

test("new schema fields parse while strict legacy receipt has no route", () => {
  expect(StackMakeResult.safeParse({ id: "x", job: "clip", state: "running", percent: 0, status: "Making", files: [], poster: null, made_with: { part: "minimax-h3", label: "H3", pack_version: "1", shape: "landscape", seconds: 5, sound: false, notes: [], route: "words", route_reason: "From words." } }).success).toBe(true);
  expect(StackMakeRefusal.safeParse({ code: "needs_start_picture", line: "Make a picture.", shape: "landscape", inputs: ["identity"] }).success).toBe(true);
  const base = { version: 1, job_id: "x", operation: "generate", made_at: new Date().toISOString(), runtime: { id: "r", revision: "1" }, model: { id: "m", build: "b", quantization: null }, steps: { count: null, schedule: null }, adapter: null, inputs: [], requested: { width: 1, height: 1, frames: 0, seconds: 0 }, native: { width: 1, height: 1, frames: 0, fps: 24, seconds: 0, audio: false, bytes: 0 }, delivered: { width: 1, height: 1, frames: 0, fps: 24, seconds: 0, audio: false, bytes: 0 }, delivered_is: "native", seed: null, phases: [], peak_memory_bytes: null, finish: [], prompt: { bytes: 0, sha256: "0".repeat(64) } };
  expect(StackVideoReceipt.safeParse(base).success).toBe(true);
  expect(StackVideoReceipt.safeParse({ ...base, route: { name: "words", reason: "From words." } }).success).toBe(true);
  expect(StackVideoReceipt.safeParse({ ...base, route: { name: "words", reason: "From words.", extra: true } }).success).toBe(false);
});

test("needs_start_picture says what the picture must be: the request's shape and the identity input to use; the spec accepts it", () => {
  for (const shape of ["landscape", "portrait"]) {
    const planned = planClipRoute(req({ shape, inputs: [{ role: "identity", file: "i" }] }), h3);
    expect(planned).toMatchObject({ ok: false, refusal: { code: "needs_start_picture", shape, inputs: ["identity"] } });
    if (!planned.ok) expect(StackMakeRefusal.safeParse(planned.refusal).success).toBe(true);
  }
});

test("the resend after a derivation carries its start picture, is never answered needs_start_picture again, and the receipt reason records it", () => {
  const planned = planClipRoute(req({ intent: "derived_start", start_picture: "p", inputs: [{ role: "identity", file: "i" }] }), h3);
  expect(planned).toMatchObject({ ok: true, route: "start_picture", reason: "The start picture was made from the identity picture and opens the shot." });
  // marked derived but with no start picture: an error, not a second derivation
  const bad = planClipRoute(req({ intent: "derived_start", inputs: [{ role: "identity", file: "i" }] }), h3);
  expect(bad).toMatchObject({ ok: false, refusal: { code: "input_not_supported" } });
});
