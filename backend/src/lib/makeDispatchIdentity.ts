// VF-ROUTE-DERIVE-01: the generic `picture` job acting on a typed `identity` input. The Stack makes the picture: the serving pack's
// `picture_edit` job (the one that keeps a likeness) draws the person from the identity picture into a blank canvas of the request's shape, with the
// words the pack's own recipe writes (its `---identity---` part). Nothing here names a model or writes a prompt (rule E7), and nothing about the
// person is logged: no names, no pixels of the person, only the job's own counts and timings elsewhere. An identity input the serving picture pack
// cannot use is refused plainly, never answered with a words-only picture (that would put a stranger in the clip).
import { deflateSync } from "node:zlib";
import type { StackMakeRequest, StackMakeResult } from "@maipai/spec/stack/ts/stack-make.js";
import type { StackPartView } from "@maipai/spec/stack/ts/stack-part-view.js";
import { dispatchPictureEdit, type FormForward, type PictureBytes } from "@/lib/makeDispatch";
import { servingFor } from "@/lib/jobsCatalog";
import { planMake } from "@/lib/makePlan";
import { fillRecipe } from "@/lib/recipe";

type PictureRequest = Extract<StackMakeRequest, { job: "picture" }>;
export const IDENTITY_NOT_USABLE_LINE = "Nothing turned on here can make a picture of a person from their picture. An admin can turn on a picture model that keeps a likeness in Settings, AI and models.";
export const IDENTITY_NOTE = "An identity picture was used to make this picture.";

export const hasIdentityInput = (request: StackMakeRequest): request is PictureRequest => request.job === "picture" && (request.inputs ?? []).some((input) => input.role === "identity");

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (bytes: Uint8Array): number => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length); const view = new DataView(out.buffer);
  view.setUint32(0, data.length); for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i); out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length))); return out;
}
/** A flat mid-grey picture of the given size: the blank frame the person is drawn into, so the picture has the request's shape. */
export function blankCanvasPng(width: number, height: number): Uint8Array {
  const header = new Uint8Array(13); const view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height); header[8] = 8; header[9] = 2;
  const row = new Uint8Array(1 + width * 3).fill(128); row[0] = 0;
  const raw = new Uint8Array(row.length * height); for (let y = 0; y < height; y += 1) raw.set(row, y * row.length);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let at = 0; for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

const refuse = (line: string) => ({ status: 422, body: { code: "input_not_supported", line } });

export async function dispatchIdentityPicture(request: PictureRequest, parts: readonly StackPartView[], read: PictureBytes, forwardForm: FormForward): Promise<{ status: number; body: unknown }> {
  const inputs = request.inputs ?? [];
  if (inputs.some((input) => input.role === "voice_reference" || input.role === "edit_source")) return refuse("A picture can use an identity or a wardrobe picture, not a voice or a clip.");
  const identity = inputs.filter((input) => input.role === "identity");
  const wardrobe = inputs.filter((input) => input.role === "wardrobe");
  // ONE identity picture by default; the wardrobe pictures ride along as further references.
  const references = [identity[0]!.file, ...wardrobe.map((input) => input.file)];
  const probe = { job: "picture_edit", audience: request.audience, picture: identity[0]!.file, description: request.description, ...(request.words ? { words: request.words } : {}), references: references.slice(1), level: request.level, ...(request.part ? { part: request.part } : {}) } as Extract<StackMakeRequest, { job: "picture_edit" }>;
  const plan = planMake(probe, parts);
  if (!plan.ok || !plan.serving.job.capabilities.keeps_likeness) return refuse(IDENTITY_NOT_USABLE_LINE);
  const maker = servingFor("picture", request.audience, parts).find((serving) => serving.part.id === plan.serving.part.id);
  const pixels = (maker?.job.limits.shapes as Record<string, Record<string, { width: number; height: number } | undefined> | undefined> | undefined)?.[request.shape]?.[plan.level];
  if (!pixels) return refuse("This model cannot make that shape of picture from a person's picture. Choose another shape.");
  const canvas = `data:image/png;base64,${Buffer.from(blankCanvasPng(pixels.width, pixels.height)).toString("base64")}`;
  const edit = { ...probe, picture: canvas, references } as Extract<StackMakeRequest, { job: "picture_edit" }>;
  const recipe = plan.serving.pack.recipes[plan.serving.job.recipe] ?? "{description}";
  const instruction = fillRecipe(recipe, { description: request.description, words: request.words, identity: true });
  const sent = await dispatchPictureEdit(edit, plan, read, (path, form) => { form.set("instruction", instruction); return forwardForm(path, form); });
  const body = sent.body as StackMakeResult | { code?: string };
  if ((sent.status !== 200 && sent.status !== 202) || !("made_with" in body) || !body.made_with) return sent;
  return { status: sent.status, body: { ...body, job: "picture", made_with: { ...body.made_with, shape: request.shape, notes: [...body.made_with.notes, IDENTITY_NOTE] } } };
}
