// VF-ROUTE-DERIVE-01: the generic `picture` job acting on an identity input. A fake edit route records the form; no model runs.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { PART_DEFS } from "@/lib/partDefs";
import { __setPartsHardwareForTests } from "@/lib/partsList";
import { __resetPartChoicesForTests } from "@/lib/partChoices";
import { blankCanvasPng, dispatchIdentityPicture, hasIdentityInput, IDENTITY_NOT_USABLE_LINE, IDENTITY_NOTE } from "@/lib/makeDispatchIdentity";
import { StackMakeResult, type StackMakeRequest } from "@maipai/spec/stack/ts/stack-make.js";
import type { StackPartView } from "@maipai/spec/stack/ts/stack-part-view.js";
import type { HardwareInfo } from "@/lib/hardware";

const GB = 1_073_741_824;
const hw: HardwareInfo = { platform: "darwin", arch: "arm64", totalRamGb: 128, cpuCount: 16, isAppleSilicon: true, unifiedMemoryGb: 128, cudaDevices: [], freeDiskBytes: 1500 * GB, osVersion: "test" };
beforeEach(() => { __resetPartChoicesForTests(); __setPartsHardwareForTests(hw); });
afterEach(() => { __resetPartChoicesForTests(); __setPartsHardwareForTests(null); });
const ready = (id: string): StackPartView => { const d = PART_DEFS.find((p) => p.id === id)!; return { id, kind: d.kind, category: d.category, priority: d.priority, label: d.label, description: "", enabled: true, state: "ready", size_bytes: 1, download_bytes: 1, percent: null, fits: { standard: true, boost: true, max: true, reason: null }, can_install: false, install_block: null, can_uninstall: true, uninstall_block: null, licence_needed: false, required_by: [], update: { available: false, version: null } } as StackPartView; };
const parts = [ready("flux3-image-klein"), ready("minimax-h3-image")];
type Pic = Extract<StackMakeRequest, { job: "picture" }>;
const req = (over: Partial<Pic> = {}): Pic => ({ job: "picture", audience: "adult", description: "at a kitchen counter in morning light", shape: "square", level: "standard", inputs: [{ role: "identity", file: "/v1/images/generations/a/0.png" }], intent: "new_shot", ...over });
const PNG_OF = (url: string) => Buffer.from(url.split(",")[1]!, "base64");
const read = async (reference: string) => reference.startsWith("data:") ? { bytes: new Uint8Array(PNG_OF(reference)), type: "image/png" } : { bytes: new Uint8Array([1, 2, 3]), type: "image/png" };

function fake() {
  const calls: Array<{ path: string; fields: Record<string, string>; files: Record<string, File> }> = [];
  const forwardForm = async (path: string, form: FormData) => {
    const fields: Record<string, string> = {}; const files: Record<string, File> = {};
    for (const [key, value] of form.entries()) { if (typeof value === "string") fields[key] = value; else files[key] = value; }
    calls.push({ path, fields, files });
    return { status: 200, json: { job: "img1", data: [{ url: "/v1/images/edits/img1" }], notes: ["made"] } };
  };
  return { calls, forwardForm };
}

test("an identity input is detected only on a picture job", () => {
  expect(hasIdentityInput(req())).toBe(true);
  expect(hasIdentityInput(req({ inputs: [] }))).toBe(false);
  expect(hasIdentityInput({ ...req(), job: "clip" } as never)).toBe(false);
});

test("the Stack draws the person into a blank canvas of the request's shape, with the pack's own identity words, and says so in made_with", async () => {
  const f = fake();
  const result = await dispatchIdentityPicture(req(), parts, read, f.forwardForm);
  expect(result.status).toBe(200);
  expect(f.calls).toHaveLength(1);
  const call = f.calls[0]!;
  expect(call.path).toBe("/v1/images/edits");
  const png = new Uint8Array(await call.files.image!.arrayBuffer());
  const view = new DataView(png.buffer, png.byteOffset); // IHDR width and height at bytes 16 and 20
  expect([view.getUint32(16), view.getUint32(20)]).toEqual([1024, 1024]);
  expect(call.fields.instruction).toContain("Put the person shown in the reference picture into this scene: at a kitchen counter in morning light");
  expect(call.fields.instruction).not.toContain("Change the given picture");
  expect(call.files.reference).toBeDefined();
  const body = result.body as StackMakeResult;
  expect(StackMakeResult.safeParse(body).success).toBe(true);
  expect(body).toMatchObject({ job: "picture", made_with: { shape: "square" } });
  expect(body.made_with!.notes).toContain(IDENTITY_NOTE);
});

test("a first picture has the clip's shape: landscape and portrait come from the pack's first_picture_shapes, which ordinary shapes never list", async () => {
  for (const [shape, size] of [["landscape", [1344, 768]], ["portrait", [768, 1344]]] as const) {
    const f = fake();
    expect((await dispatchIdentityPicture(req({ shape }), parts, read, f.forwardForm)).status, shape).toBe(200);
    const png = new Uint8Array(await f.calls[0]!.files.image!.arrayBuffer()); const view = new DataView(png.buffer, png.byteOffset);
    expect([view.getUint32(16), view.getUint32(20)], shape).toEqual([...size]);
  }
  // the screens read `shapes` only: the picture packs' ordinary limits stay square
  const { packs } = await import("@/packs/loader");
  for (const pack of packs().filter((item) => ["flux3-image-klein", "minimax-h3-image"].includes(item.pack.part))) {
    for (const name of ["picture", "picture_edit"]) expect(Object.keys(pack.pack.jobs.find((job) => job.job === name)!.limits.shapes ?? {}), `${pack.pack.part} ${name}`).toEqual(["square"]);
  }
});

test("a level the first-picture shapes do not declare is refused plainly, never answered with another size", async () => {
  const f = fake();
  expect(await dispatchIdentityPicture(req({ shape: "landscape", level: "max" }), parts, read, f.forwardForm)).toMatchObject({ status: 422, body: { code: "input_not_supported" } });
  expect(f.calls).toHaveLength(0);
});

test("only one identity picture is used by default, and a wardrobe picture rides along as a second reference", async () => {
  const f = fake();
  await dispatchIdentityPicture(req({ inputs: [{ role: "identity", file: "/v1/images/generations/a/0.png" }, { role: "identity", file: "/v1/images/generations/b/0.png" }, { role: "wardrobe", file: "/v1/images/generations/w/0.png" }] }), parts, read, f.forwardForm);
  const call = f.calls[0]!;
  expect(Object.keys(call.files).filter((key) => key.startsWith("reference")).sort()).toEqual(["reference", "reference2"]);
});

test("a minor's picture is made the same way, names no model in a refusal, and a pack that cannot keep a likeness is refused, never made from words alone", async () => {
  const f = fake();
  const none = await dispatchIdentityPicture(req({ audience: "minor" }), [], read, f.forwardForm);
  expect(none).toEqual({ status: 422, body: { code: "input_not_supported", line: IDENTITY_NOT_USABLE_LINE } });
  expect(f.calls).toHaveLength(0);
  expect(IDENTITY_NOT_USABLE_LINE).not.toMatch(/flux|minimax|klein/i);
});

test("a voice or a clip as input to a picture is refused plainly; an unreadable identity picture is not_available, not dropped", async () => {
  const f = fake();
  expect(await dispatchIdentityPicture(req({ inputs: [{ role: "identity", file: "x" }, { role: "voice_reference", file: "v" }] }), parts, read, f.forwardForm)).toMatchObject({ status: 422, body: { code: "input_not_supported" } });
  const unreadable = await dispatchIdentityPicture(req(), parts, async (reference) => reference.startsWith("data:") ? read(reference) : null, f.forwardForm);
  expect(unreadable).toMatchObject({ status: 409, body: { code: "not_available" } });
  expect(f.calls).toHaveLength(0);
});

test("the blank canvas is a valid PNG of the asked size", () => {
  const png = blankCanvasPng(64, 32);
  expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer, png.byteOffset);
  expect([view.getUint32(16), view.getUint32(20)]).toEqual([64, 32]);
});
