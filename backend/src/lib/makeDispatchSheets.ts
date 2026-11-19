// SHEET-01, the sheet family: character_sheet and contact_sheet. Each panel or tile is one run of the picture-edit path (dispatchPictureEdit in
// makeDispatch.ts), the first reference being the picture to change and the rest riding along as references, with the serving pack's recipe
// for the job wrapped around a per-panel instruction. Panels are made one after another so the order in the answer is the order made and only
// one picture is ever in the engine at a time. Nothing here names a model: the pack's recipe and limits do that work.
import type { StackMakeRequest, StackMakeResult } from "@maipai/spec/stack/ts/stack-make.js";
import type { MakePlan } from "@/lib/makePlan";
import { dispatchPictureEdit, PICTURE_UNREADABLE_LINE, type FormForward, type PictureBytes } from "@/lib/makeDispatch";

type Planned = Extract<MakePlan, { ok: true }>;
type CharacterRequest = Extract<StackMakeRequest, { job: "character_sheet" }>;
type ContactRequest = Extract<StackMakeRequest, { job: "contact_sheet" }>;
type Kind = CharacterRequest["kind"];

/** A contact sheet is one engine run per tile, each taking about a minute, so the count is capped. */
export const CONTACT_SHEET_MAX_TILES = 12;
export const CONTACT_SHEET_TOO_MANY_LINE = `A contact sheet holds up to ${CONTACT_SHEET_MAX_TILES} tiles. Ask for fewer, or make a second sheet.`;

/** The panels of a character sheet, in the order they are returned: turnaround first, then expressions, then poses. */
const PANELS: Readonly<Record<Kind, readonly string[]>> = {
  person: [
    "Show the person from the front, standing straight, arms relaxed at the sides, looking at the viewer, full body",
    "Show the person from the side, in profile, standing straight, full body",
    "Show the person from the back, standing straight, full body",
    "Show the same person from the chest up, smiling warmly",
    "Show the same person from the chest up, with a serious, thoughtful face",
    "Show the same person from the chest up, laughing with the mouth open",
    "Show the same person, full body, walking forward in mid-stride",
    "Show the same person, full body, sitting down with a relaxed posture",
  ],
  pet: [
    "Show the animal from the front, standing, looking at the viewer, full body",
    "Show the animal from the side, in profile, standing, full body",
    "Show the animal from behind, standing, full body",
    "Show the same animal's face close up, happy, mouth slightly open",
    "Show the same animal's face close up, calm, mouth closed",
    "Show the same animal, full body, sitting",
    "Show the same animal, full body, lying down",
  ],
  object: [
    "Show the object from the front, centered, filling the frame",
    "Show the object from the left side",
    "Show the object from the back",
    "Show the object from above, looking straight down",
    "Show the object at a three quarter angle from the front right",
    "Show a close up of the most detailed part of the object",
  ],
};

/** The view each contact sheet tile asks for, cycled when a sheet has more tiles than views. */
const TILE_VIEWS: readonly string[] = [
  "a wide shot showing the whole subject with room around it",
  "a close up of the face or the most important part",
  "a view from slightly above",
  "a view from slightly below, looking up",
  "a view from the left side",
  "a view from the right side",
  "a three quarter view from the front left",
  "a three quarter view from the front right",
  "a view from behind",
  "a medium shot from the waist or middle up",
  "a candid moment, looking away from the viewer",
  "a view from far away, small in the frame",
];

const SUBJECT_WORDS: Readonly<Record<Kind, string>> = { person: "person", pet: "animal", object: "object" };

const refused = (line: string) => ({ status: 409, body: { code: "not_available", line } });
const UNREADABLE = refused(PICTURE_UNREADABLE_LINE);

/** Read every reference once up front, so a bad one is refused before any panel is made and none is read twice. */
async function readAll(references: readonly string[], read: PictureBytes): Promise<{ found: Map<string, { bytes: Uint8Array; type: string }> } | null> {
  const found = new Map<string, { bytes: Uint8Array; type: string }>();
  for (const reference of references) {
    const got = await read(reference);
    if (!got) return null;
    found.set(reference, got);
  }
  return { found };
}

export function characterPanelPrompts(kind: Kind, description?: string): string[] {
  const subject = description?.trim();
  return PANELS[kind].map((view) => (subject ? `${view}. The ${SUBJECT_WORDS[kind]} is: ${subject}` : view));
}

export function contactTilePrompts(count: number, description?: string): string[] {
  const subject = description?.trim();
  return Array.from({ length: count }, (_, i) => {
    const view = TILE_VIEWS[i % TILE_VIEWS.length]!;
    return subject ? `Make a new picture of the same subject as ${view}. The subject is: ${subject}` : `Make a new picture of the same subject as ${view}`;
  });
}

/** Run the edit path once per prompt, in order. A refusal from the edit path ends the sheet and is passed through; a panel still running ends it as running. */
async function makePieces(job: "character_sheet" | "contact_sheet", request: { audience: CharacterRequest["audience"]; level: CharacterRequest["level"]; references: string[] }, prompts: string[], plan: Planned, read: PictureBytes, forward: FormForward): Promise<{ status: number; body: unknown }> {
  const bytes = await readAll(request.references, read);
  if (!bytes) return UNREADABLE;
  const cached: PictureBytes = async (reference) => bytes.found.get(reference) ?? null;
  const [main, ...rest] = request.references as [string, ...string[]];
  const pieces: string[] = [];
  const notes: string[] = [];
  let lastId = "";
  for (const [index, description] of prompts.entries()) {
    const made = await dispatchPictureEdit({ job: "picture_edit", audience: request.audience, picture: main, description, level: request.level, ...(rest.length ? { references: rest } : {}) }, plan, cached, forward);
    if (made.status !== 200 && made.status !== 202) return made;
    const piece = made.body as { id: string; state: string; files: string[]; made_with: { notes: string[] } | null };
    lastId = piece.id || lastId;
    notes.push(...(piece.made_with?.notes ?? []));
    const file = piece.files[0];
    if (made.status === 202 || piece.state !== "done" || !file) {
      const total = prompts.length;
      return { status: 202, body: sheetResult(job, piece.id || lastId, "running", Math.floor((index * 100) / total), `Making ${job === "character_sheet" ? "panel" : "tile"} ${index + 1} of ${total}`, pieces, plan, notes) };
    }
    pieces.push(file);
  }
  return { status: 200, body: sheetResult(job, lastId, "done", 100, "Done", pieces, plan, notes) };
}

function sheetResult(job: "character_sheet" | "contact_sheet", id: string, state: "done" | "running", percent: number, status: string, pieces: string[], plan: Planned, notes: string[]): StackMakeResult {
  const base = {
    id, state, percent, status, files: pieces, poster: pieces[0] ?? null,
    made_with: { part: plan.serving.part.id, label: plan.serving.part.label, pack_version: plan.serving.pack.pack.version, shape: null, seconds: null, sound: false, notes: [...new Set(notes)] },
  };
  return job === "character_sheet" ? { ...base, job, panels: pieces } : { ...base, job, tiles: pieces };
}

export async function dispatchCharacterSheet(request: CharacterRequest, plan: Planned, read: PictureBytes, forward: FormForward): Promise<{ status: number; body: unknown }> {
  return makePieces("character_sheet", request, characterPanelPrompts(request.kind, request.description), plan, read, forward);
}

export async function dispatchContactSheet(request: ContactRequest, plan: Planned, read: PictureBytes, forward: FormForward): Promise<{ status: number; body: unknown }> {
  if (request.count > CONTACT_SHEET_MAX_TILES) return refused(CONTACT_SHEET_TOO_MANY_LINE);
  return makePieces("contact_sheet", request, contactTilePrompts(request.count, request.description), plan, read, forward);
}
