import { expect, test } from "bun:test";
import { StackReferenceClipRules } from "@maipai/spec/stack/ts/stack-model-pack.js";
import { planClipRoute } from "@/lib/clipRoute";
import { rowsForJob } from "@/video/caps";
import { jobsCatalog } from "@/lib/jobsCatalog";
import { dispatchClip } from "@/lib/makeDispatch";
import { packs, packFor, referenceClipRules } from "@/packs/loader";

const part = packs().find((candidate) => candidate.pack.jobs.some((job) => job.job === "clip" && job.reference_clip))!.pack.part;
const rules = referenceClipRules(part)!;
const rows = rowsForJob(part, "clip");
const sampleInputs = [{ role: "identity", file: "person.png" }, { role: "identity", file: "person-2.png" }, { role: "object", file: "object.png" }, { role: "place", file: "place.png" }] as const;
const req = (over: Record<string, unknown> = {}) => ({ job: "clip", operation: "reference_clip", audience: "adult", description: "A short scene", shape: "landscape", level: "max", seconds: 6, inputs: sampleInputs, ...over }) as never;

test("reference clip pack rules load and satisfy the pinned schema", () => {
  expect(StackReferenceClipRules.safeParse(rules).success).toBe(true);
  expect(rules).toEqual({ max_people: 2, face_gate: 0.5, clip_face_low: 0.35, clip_face_frames: 6, redraws: 2, seconds: { min: 4, max: 8 } });
  expect(packFor(part)?.pack.jobs.find((job) => job.job === "clip")?.reference_clip).toEqual(rules);
});

test("reference clip accepts supported role mixes and refuses unsupported or empty inputs", () => {
  expect(planClipRoute(req({ start_picture: "first.png" }), rows, false, rules)).toMatchObject({ ok: true, identityUsed: 2, roleCounts: { identity: 2, object: 1, place: 1 } });
  expect(planClipRoute(req({ inputs: [{ role: "wardrobe", file: "x" }] }), rows, false, rules)).toMatchObject({ ok: false, refusal: { code: "input_not_supported", line: "Send pictures for people, objects or places only." } });
  expect(planClipRoute(req({ inputs: [] }), rows, false, rules)).toMatchObject({ ok: false, refusal: { code: "input_not_supported", line: "Send a picture with a usable role: person, object or place." } });
  expect(planClipRoute(req({ inputs: [{ role: "object", file: "x" }] }), rows, false, rules)).toMatchObject({ ok: false, refusal: { code: "input_not_supported", line: expect.stringContaining("prepared Ingredients sheet") } });
});

test("reference clip enforces people count, route mix and pack limits", () => {
  expect(planClipRoute(req({ start_picture: "first.png", inputs: sampleInputs.slice(0, 2) }), rows, false, rules)).toMatchObject({ ok: true, route: "start_picture" });
  expect(planClipRoute(req({ start_picture: "first.png", inputs: [...sampleInputs.slice(0, 2), { role: "identity", file: "third.png" }] }), rows, false, rules)).toMatchObject({ ok: false, refusal: { line: expect.stringContaining("no more than 2") } });
  expect(planClipRoute(req(), rows, false, rules)).toMatchObject({ ok: false, refusal: { code: "needs_start_picture", shape: "landscape", inputs: ["identity", "object", "place"] } });
  expect(planClipRoute(req({ start_picture: "first.png", seconds: 3 }), rows, false, rules)).toMatchObject({ ok: false, refusal: { line: expect.stringContaining("4 to 8") } });
  expect(planClipRoute(req({ start_picture: "first.png", seconds: 9 }), rows, false, rules)).toMatchObject({ ok: false, refusal: { code: "input_not_supported" } });
  expect(planClipRoute(req({ start_picture: "first.png", level: "standard" }), rows, false, rules)).toMatchObject({ ok: false, refusal: { line: expect.stringContaining("Max") } });
  expect(planClipRoute(req({ audience: "minor", start_picture: "first.png" }), rows, false, rules)).toMatchObject({ ok: false, refusal: { line: expect.stringContaining("viewer") } });
  expect(planClipRoute(req({ start_picture: "first.png", end_picture: "last.png" }), rows, false, rules)).toMatchObject({ ok: false, refusal: { line: expect.stringContaining("end picture") } });
  expect(planClipRoute(req({ start_picture: "first.png" }), rows, false, null)).toMatchObject({ ok: false, refusal: { code: "input_not_supported" } });
});

test("catalog advertises reference roles and pack limits as machine-readable fields", async () => {
  const clip = (await jobsCatalog("adult")).jobs.find((job) => job.job === "clip")!;
  expect(clip.request_fields).toEqual(expect.arrayContaining(["operation", "inputs.role.identity", "inputs.role.object", "inputs.role.place", "reference_clip.max_people=2", "reference_clip.seconds.min=4", "reference_clip.seconds.max=8"]));
});

test("dispatch forwards the reference route and records input role hashes without a new engine shape", async () => {
  const loaded = packFor(part)!;
  const plan = { ok: true, serving: { pack: loaded, job: loaded.pack.jobs.find((job) => job.job === "clip"), part: { id: part, label: "Max" } }, level: "max", shape: "landscape", seconds: 6 } as never;
  let sent: Record<string, unknown> = {};
  const result = await dispatchClip(req({ start_picture: "first.png" }), plan, async (path, body) => {
    expect(path).toBe("/v1/videos/generations");
    sent = body as Record<string, unknown>;
    return { status: 200, json: { job: "fake-job", data: [] } };
  }, async () => ({ bytes: new Uint8Array([1, 2, 3]), type: "image/png" }));
  expect(result.status).toBe(200);
  expect(sent.route).toMatchObject({ name: "reference_clip", reason: expect.stringContaining("composed first picture") });
  expect(sent.roles).toHaveLength(4);
  expect((sent.roles as Array<{ role: string }>).map((role) => role.role)).toEqual(["identity", "identity", "object", "place"]);
});
