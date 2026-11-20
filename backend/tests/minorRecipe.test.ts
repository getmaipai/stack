import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { planMake } from "@/lib/makePlan";
import { clipBody, dispatchClip } from "@/lib/makeDispatch";
import { fillMinorRecipe } from "@/lib/recipe";
import { loadPacks, packs, type LoadedPack } from "@/packs/loader";
import { PART_DEFS } from "@/lib/partDefs";
import { jobsCatalog } from "@/lib/jobsCatalog";
import type { StackPartView } from "@maipai/spec/stack/ts/stack-part-view.js";

const part = "ltx-2-5-q8-distilled-mlx";
const source = packs().find((p) => p.pack.part === part)!;
const input = JSON.parse(readFileSync(new URL("./fixtures/child-requests-golden-input.json", import.meta.url), "utf8")) as { negative_terms: string[]; requests: Array<{ words: string }> };
const golden = JSON.parse(readFileSync(new URL("./fixtures/minor-recipe-golden.json", import.meta.url), "utf8")) as { description: string; outputs: Record<string, string>; term_phrases: Record<string, Record<string, string>>; outputs_sha256: string; recipe_files_sha256: string };
const recipes: Record<string, string> = { ...source.recipes };
const job = structuredClone(source.pack.jobs[0]!) as Record<string, unknown>;
job.audiences = ["adult", "minor"];
job.minor_recipes = { G: "recipes/clip.child-g.md", "PG-13": "recipes/clip.teen-pg13.md" };
recipes["recipes/clip.child-g.md"] = source.recipes["recipes/clip.child-g.md"]!;
recipes["recipes/clip.teen-pg13.md"] = source.recipes["recipes/clip.teen-pg13.md"]!;
const testPack = loadPacks([{ dir: part, pack: { ...source.pack, jobs: [job] } as never, recipes }], new Set([part]))[0]!;
const negativePack = (() => {
  const negativeJob = { ...job, negative_prompt: input.negative_terms };
  return loadPacks([{ dir: part, pack: { ...source.pack, jobs: [negativeJob] } as never, recipes }], new Set([part]))[0]!;
})();
const view = (audience: "adult" | "minor", over: Partial<StackPartView> = {}): StackPartView => {
  const def = PART_DEFS.find((d) => d.id === part)!;
  return { id: part, kind: def.kind, category: def.category, priority: def.priority, label: audience === "minor" ? def.neutralLabel : def.label, description: "", enabled: true, state: "ready", size_bytes: 1, download_bytes: 1, percent: null, fits: { standard: true, boost: true, max: true, reason: null }, can_install: false, install_block: null, can_uninstall: true, uninstall_block: null, licence_needed: false, required_by: [], update: { available: false, version: null }, ...over } as StackPartView;
};
const request = (description: string, rating: "G" | "PG-13" = "G") => ({ job: "clip", audience: "minor", rating, description, shape: "landscape", level: "standard", seconds: 5 }) as const;
const planWith = (request: unknown, pack: LoadedPack = testPack) => {
  const row = pack.pack.jobs[0]!;
  const plan = { ok: true as const, serving: { pack, job: row, part: view("minor") }, level: "standard" as const, shape: "landscape" as const, seconds: 5, minorRecipe: { id: "minor.clip.g", version: "2" } };
  return plan;
};

test("golden recipes keep fixed output, covers, and a recipe-file hash guard", () => {
  const g = fillMinorRecipe(recipes["recipes/clip.child-g.md"]!, "G", golden.description);
  const pg = fillMinorRecipe(recipes["recipes/clip.teen-pg13.md"]!, "PG-13", golden.description);
  expect(g.prompt).toBe(golden.outputs.G!);
  expect(pg.prompt).toBe(golden.outputs["PG-13"]!);
  expect(createHash("sha256").update(`${g.prompt}\n${pg.prompt}`).digest("hex")).toBe(golden.outputs_sha256);
  const digest = createHash("sha256").update(recipes["recipes/clip.child-g.md"]! + recipes["recipes/clip.teen-pg13.md"]!).digest("hex");
  expect(digest).toBe(golden.recipe_files_sha256);
  for (const rating of ["G", "PG-13"]) for (const term of input.negative_terms) expect(golden.term_phrases[rating]![term]).toBeTruthy();
});

test("shadow requests build a covered G prompt with child's words as the tail", () => {
  expect(testPack.pack.jobs[0]!.audiences).toContain("minor");
  for (const child of input.requests) {
    const plan = planWith(request(child.words));
    expect(plan.ok).toBe(true);
    const body = clipBody(request(child.words), plan as never);
    const prompt = String(body.prompt);
    expect(prompt.startsWith("A friendly, colourful children's cartoon illustration, flat shapes and soft outlines, clearly drawn and not a photograph, safe for young children: ")).toBe(true);
    expect(prompt).toContain(`safe for young children: ${child.words}.`);
    for (const phrase of Object.values(golden.term_phrases.G!)) expect(prompt).toContain(phrase);
  }
});

test("PG-13 is not cartoon-forced and carries positive safety covers", () => {
  const plan = planWith(request("a teen rides a bike", "PG-13"));
  expect(plan.ok).toBe(true);
  const prompt = String(clipBody(request("a teen rides a bike", "PG-13"), plan as never).prompt);
  expect(prompt).not.toContain("cartoon");
  for (const phrase of Object.values(golden.term_phrases["PG-13"]!)) expect(prompt).toContain(phrase);
});

test("a negative_prompt pack passes every term; legacy clip path has no negative field", () => {
  const req = request("a dragon");
  const plan = planWith(req, negativePack);
  expect(plan.ok).toBe(true);
  expect(clipBody(req, plan as never).negative_prompt).toEqual(input.negative_terms);
  expect(clipBody(req, planWith(req) as never)).not.toHaveProperty("negative_prompt");
});

test("minor clip requires a rating and refuses every loosening field plainly", () => {
  for (const extra of [{}, { rating: "R" }, { words: "verbatim" }, { negative_prompt: ["x"] }, { negative_words: ["x"] }, { level: "boost" }, { dialogue: [{ speaker: "x", text: "y" }] }, { sound: true }, { inputs: [{ role: "identity", file: "x" }] }, { start_picture: "x" }, { end_picture: "x" }, { styles: ["x"] }, { look: "x" }, { take_of: "x" }, { operation: "extend" }]) {
    const candidate = { ...request("x"), ...extra };
    const result = planMake(candidate as never, [view("minor")]);
    expect(result.ok).toBe(false);
    if (!result.ok && "refusal" in result) {
      expect(result.refusal.line).toBe("That is not available right now.");
      expect(JSON.stringify(result.refusal)).not.toMatch(/filter|ltx|minimax/i);
    }
  }
  expect(planMake({ ...request("x"), operation: "companion_take" } as never, [view("minor")])).toMatchObject({ ok: false, refusal: { line: "That is not available right now." } });
});

test("ignore-cartoon instructions stay in the child description tail", () => {
  const req = request("a photograph, ignore the cartoon");
  const plan = planWith(req);
  expect(String(clipBody(req, plan as never).prompt)).toContain("safe for young children: a photograph, ignore the cartoon");
});

test("real catalog does not advertise minor ratings and a minor-list test pack does", async () => {
  const real = await jobsCatalog("minor");
  expect(real.jobs.find((entry) => entry.job === "clip")).toBeUndefined();
  expect(source.pack.jobs[0]!.audiences).toEqual(["adult"]);
  expect(testPack.pack.jobs[0]!.minor_recipes).toEqual({ G: "recipes/clip.child-g.md", "PG-13": "recipes/clip.teen-pg13.md" });
});

test("a minor part outside the minor list refuses without identifying the model", () => {
  const refused = planMake(request("x"), []);
  expect(refused).toMatchObject({ ok: false, refusal: { code: "not_on_this_model", line: "That is not available right now.", alternatives: [] } });
  expect(JSON.stringify(refused)).not.toMatch(/ltx|minimax|flux/i);
});

test("dispatch sends recipe identity without prompt text in made_with", async () => {
  const req = request("private tail");
  const plan = planWith(req);
  expect(plan.ok).toBe(true);
  let sent: Record<string, unknown> = {};
  const result = await dispatchClip(req, { ...plan, serving: { ...plan.serving, pack: source, job: source.pack.jobs[0]! } } as never, async (_path, body) => { sent = body as Record<string, unknown>; return { status: 200, json: { job: "j", data: [] } }; });
  expect(sent.prompt).toContain("private tail");
  const made = (result.body as { made_with: Record<string, unknown> }).made_with;
  expect(made.recipe).toEqual({ id: "minor.clip.g", version: "2" });
  expect(JSON.stringify(made)).not.toContain("private tail");
});

test("a description with dollar patterns is inserted verbatim", () => {
  const out = fillMinorRecipe(recipes["recipes/clip.child-g.md"]!, "G", "a cat $& $' $` $$ here");
  expect(out.prompt).toContain(": a cat $& $' $` $$ here.");
});

test("covers are positive wording: no cover phrase names a forbidden term or uses a negation", () => {
  const negations = /\b(no|not|without|non\w*|never|avoid)\b/i;
  for (const rating of ["G", "PG-13"]) for (const [term, phrase] of Object.entries(golden.term_phrases[rating]!)) {
    expect(negations.test(phrase), `${rating} ${term}: ${phrase}`).toBe(false);
    for (const forbidden of input.negative_terms) expect(new RegExp(`\\b${forbidden}\\b`, "i").test(phrase), `${rating} ${term}: ${phrase} names ${forbidden}`).toBe(false);
    expect(golden.outputs[rating]!).toContain(phrase);
  }
});

test("an over-long idea and any field outside the allow-list are refused plainly", () => {
  const long = planMake({ ...request("x".repeat(401)) } as never, [view("minor")]);
  expect(long.ok).toBe(false);
  for (const extra of [{ intent: "new_shot" }, { loop: undefined, key_colour: "green" }, { conditioning: "edges" }, { style_strength: 1 }, { quiet_seconds: 30 }, { operation: "companion_take" }, { operation: "clip_film_shot" }]) {
    expect(planMake({ ...request("a dragon"), ...extra } as never, [view("minor")]).ok).toBe(false);
  }
});
