import { afterEach, beforeEach, expect, test } from "bun:test";
import { planMake } from "@/lib/makePlan";
import { PART_DEFS } from "@/lib/partDefs";
import { PICTURE_UNREADABLE_LINE, WIRED_JOBS, type FormForward, type PictureBytes } from "@/lib/makeDispatch";
import { CONTACT_SHEET_MAX_TILES, characterPanelPrompts, dispatchCharacterSheet, dispatchContactSheet } from "@/lib/makeDispatchSheets";
import { __resetPartChoicesForTests } from "@/lib/partChoices";
import type { StackPartView } from "@maipai/spec/stack/ts/stack-part-view.js";
import type { StackMakeRequest } from "@maipai/spec/stack/ts/stack-make.js";

beforeEach(() => __resetPartChoicesForTests());
afterEach(() => __resetPartChoicesForTests());

const ready = (id: string): StackPartView => { const d = PART_DEFS.find((p) => p.id === id)!; return { id, kind: d.kind, category: d.category, priority: d.priority, label: d.label, description: "", enabled: true, state: "ready", size_bytes: 1, download_bytes: 1, percent: null, fits: { standard: true, boost: true, max: true, reason: null }, can_install: false, install_block: null, can_uninstall: true, uninstall_block: null, licence_needed: false, required_by: [], update: { available: false, version: null } } as StackPartView; };
type Character = Extract<StackMakeRequest, { job: "character_sheet" }>;
type Contact = Extract<StackMakeRequest, { job: "contact_sheet" }>;
const character = (over: Partial<Character> = {}): Character => ({ job: "character_sheet", audience: "adult", references: ["data:image/png;base64,AAAA"], kind: "person", level: "standard", ...over });
const contact = (over: Partial<Contact> = {}): Contact => ({ job: "contact_sheet", audience: "adult", references: ["data:image/png;base64,AAAA"], count: 3, level: "standard", ...over });
const parts = [ready("flux3-image-klein"), ready("minimax-h3-image")];
const plan = (req: StackMakeRequest) => { const p = planMake(req, parts); if (!p.ok) throw new Error("not planned"); return p; };
const read: PictureBytes = async (r) => (r.includes("BAD") ? null : { bytes: new Uint8Array([1, 2, 3]), type: "image/png" });

function fakeForward() {
  const calls: Array<{ instruction: string; references: number }> = [];
  const forward: FormForward = async (_path, form) => {
    calls.push({ instruction: String(form.get("instruction")), references: [...form.keys()].filter((k) => /^reference\d*$/.test(k)).length });
    return { status: 200, json: { job: `e${calls.length}`, data: [{}] } };
  };
  return { calls, forward };
}

test("both jobs are wired through the door", () => { expect(WIRED_JOBS.has("character_sheet") && WIRED_JOBS.has("contact_sheet")).toBe(true); });

test("a person's character sheet makes every panel in order, one edit each", async () => {
  const { calls, forward } = fakeForward();
  const result = await dispatchCharacterSheet(character({ description: "a tall woman in a green coat" }), plan(character()), read, forward);
  const expected = characterPanelPrompts("person", "a tall woman in a green coat");
  expect(result.status).toBe(200);
  expect(calls.length).toBe(expected.length);
  const body = result.body as { job: string; state: string; panels: string[]; id: string };
  expect(body).toMatchObject({ job: "character_sheet", state: "done", percent: 100 });
  expect(body.panels).toEqual(expected.map((_, i) => `/v1/images/edits/e${i + 1}`));
  expect(calls[0]!.instruction).toContain("from the front");
  expect(calls[1]!.instruction).toContain("from the side");
  expect(calls[2]!.instruction).toContain("from the back");
  expect(calls[0]!.instruction).toContain("a tall woman in a green coat");
  expect(calls[0]!.instruction).toContain("Keep the exact same subject");
});

test("the other kinds make their own panel sets, front then side then back first", () => {
  for (const kind of ["person", "pet", "object"] as const) {
    const prompts = characterPanelPrompts(kind);
    expect(prompts.length).toBeGreaterThanOrEqual(6);
    expect(prompts[0]).toContain("front");
    expect(prompts[1]).toContain("side");
    expect(prompts[2]).toMatch(/back|behind/);
  }
});

test("extra references ride along; the first is the picture to change", async () => {
  const { calls, forward } = fakeForward();
  const req = character({ kind: "object", references: ["data:image/png;base64,AAAA", "data:image/png;base64,BBBB", "data:image/png;base64,CCCC"] });
  await dispatchCharacterSheet(req, plan(req), read, forward);
  expect(calls.every((c) => c.references === 2)).toBe(true);
});

test("each reference is read once, however many panels are made", async () => {
  const reads: string[] = [];
  const counting: PictureBytes = async (r) => { reads.push(r); return read(r); };
  const { forward } = fakeForward();
  await dispatchCharacterSheet(character(), plan(character()), counting, forward);
  expect(reads.length).toBe(1);
});

test("too many references is refused with the spec's too_many_references and its limit", () => {
  const refs = Array.from({ length: 40 }, (_, i) => `data:image/png;base64,R${i}`);
  const p = planMake(character({ references: refs }), parts);
  expect(p.ok).toBe(false);
  expect(p).toMatchObject({ refusal: { code: "too_many_references", limit: expect.any(Number) } });
  const q = planMake(contact({ references: refs }), parts);
  expect(q).toMatchObject({ refusal: { code: "too_many_references" } });
});

test("an unreadable reference is refused with a plain line before any panel is made", async () => {
  const { calls, forward } = fakeForward();
  for (const run of [() => dispatchCharacterSheet(character({ references: ["data:image/png;base64,AAAA", "BAD"] }), plan(character()), read, forward), () => dispatchContactSheet(contact({ references: ["BAD"] }), plan(contact()), read, forward)]) {
    const result = await run();
    expect(result).toEqual({ status: 409, body: { code: "not_available", line: PICTURE_UNREADABLE_LINE } });
  }
  expect(calls.length).toBe(0);
});

test("a contact sheet returns the asked number of tiles in order", async () => {
  const { calls, forward } = fakeForward();
  const result = await dispatchContactSheet(contact({ count: 4 }), plan(contact()), read, forward);
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ job: "contact_sheet", state: "done", tiles: ["/v1/images/edits/e1", "/v1/images/edits/e2", "/v1/images/edits/e3", "/v1/images/edits/e4"] });
  expect(calls.length).toBe(4);
  expect(new Set(calls.map((c) => c.instruction)).size).toBe(4);
});

test("a contact sheet over the tile cap is refused with a plain line and makes nothing", async () => {
  const { calls, forward } = fakeForward();
  const result = await dispatchContactSheet(contact({ count: CONTACT_SHEET_MAX_TILES + 1 }), plan(contact()), read, forward);
  expect(result.status).toBe(409);
  expect((result.body as { line: string }).line).toContain(String(CONTACT_SHEET_MAX_TILES));
  expect(calls.length).toBe(0);
});

test("a refusal from the edit path ends the sheet and passes through", async () => {
  const forward: FormForward = async () => ({ status: 503, json: { error: "not installed", code: "not_installed" } });
  expect(await dispatchCharacterSheet(character(), plan(character()), read, forward)).toEqual({ status: 503, body: { error: "not installed", code: "not_installed" } });
});

test("a panel still running comes back as running with the panels made so far", async () => {
  let n = 0;
  const forward: FormForward = async () => { n += 1; return n < 3 ? { status: 200, json: { job: `e${n}`, data: [{}] } } : { status: 202, json: { job: "slow" } }; };
  const result = await dispatchCharacterSheet(character(), plan(character()), read, forward);
  expect(result.status).toBe(202);
  expect(result.body).toMatchObject({ job: "character_sheet", state: "running", id: "slow", panels: ["/v1/images/edits/e1", "/v1/images/edits/e2"] });
});

test("a minor's sheet names no model in a refusal or a missing-model answer", async () => {
  const labels = parts.map((p) => p.label);
  const minor = character({ audience: "minor", part: "flux3-image-klein" });
  const none = planMake(minor, []);
  const lines = [JSON.stringify(none), JSON.stringify(planMake({ ...minor, part: "minimax-h3-image" }, [parts[0]!].map((p) => ({ ...p, enabled: false })))), JSON.stringify(await dispatchContactSheet(contact({ audience: "minor", count: 99 }), plan(contact({ audience: "minor" })), read, fakeForward().forward)), JSON.stringify(await dispatchCharacterSheet(character({ audience: "minor", references: ["BAD"] }), plan(character({ audience: "minor" })), read, fakeForward().forward))];
  for (const line of lines) for (const label of labels) expect(line).not.toContain(label);
  expect(planMake(minor, [])).toMatchObject({ ok: false });
});
