import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { fillRecipe, parseRecipe } from "@/lib/recipe";
import { pictureBody, dispatchPicture } from "@/lib/makeDispatch";
import { planMake } from "@/lib/makePlan";
import { PART_DEFS } from "@/lib/partDefs";
import { __setPartsHardwareForTests } from "@/lib/partsList";
import { __resetPartChoicesForTests } from "@/lib/partChoices";
import { jobsCatalog } from "@/lib/jobsCatalog";
import type { StackPartView } from "@maipai/spec/stack/ts/stack-part-view.js";
import type { StackMakeRequest } from "@maipai/spec/stack/ts/stack-make.js";
import type { HardwareInfo } from "@/lib/hardware";

const GB = 1_073_741_824;
const hw: HardwareInfo = { platform: "darwin", arch: "arm64", totalRamGb: 128, cpuCount: 16, isAppleSilicon: true, unifiedMemoryGb: 128, cudaDevices: [], freeDiskBytes: 1500 * GB, osVersion: "test" };
beforeEach(() => { __resetPartChoicesForTests(); __setPartsHardwareForTests(hw); });
afterEach(() => { __resetPartChoicesForTests(); __setPartsHardwareForTests(null); });

const ready = (id: string): StackPartView => { const d = PART_DEFS.find((p) => p.id === id)!; return { id, kind: d.kind, category: d.category, priority: d.priority, label: d.label, description: "", enabled: true, state: "ready", size_bytes: 1, download_bytes: 1, percent: null, fits: { standard: true, boost: true, max: true, reason: null }, can_install: false, install_block: null, can_uninstall: true, uninstall_block: null, licence_needed: false, required_by: [], update: { available: false, version: null } } as StackPartView; };
const request = (over: Partial<Extract<StackMakeRequest, { job: "picture" }>> = {}): Extract<StackMakeRequest, { job: "picture" }> => ({ job: "picture", audience: "adult", description: "a red barn", shape: "square", level: "standard", seed: 7, count: 2, ...over });
const planned = (req = request()) => { const p = planMake(req, [ready("flux3-image-klein"), ready("minimax-h3-image")]); if (!p.ok) throw new Error("not planned"); return p; };

test("a recipe splits into base, words addendum and a note that is never sent", () => {
  const r = parseRecipe("{description}\n---words---\nSpell: \"{words}\"\n---measured---\nnote");
  expect(r).toEqual({ base: "{description}", wordsAddendum: "Spell: \"{words}\"", measured: "note" });
  expect(fillRecipe("{description}\n---words---\nSpell: \"{words}\"\n---measured---\nnote", { description: "a barn" })).toBe("a barn");
  expect(fillRecipe("{description}\n---words---\nSpell: \"{words}\"\n---measured---\nnote", { description: "a barn", words: "OPEN" })).toBe("a barn\n\nSpell: \"OPEN\"");
});
test("the old route's body comes from the pack: part id, pixel size, seed, count, audience, the recipe's prompt", () => {
  const body = pictureBody(request(), planned());
  expect(body).toMatchObject({ model: "flux3-image-klein", size: "1024x1024", n: 2, seed: 7, audience: "adult", prompt: "a red barn" });
});
test("exact words add the pack's spelling addendum and nothing else changes", () => {
  const body = pictureBody(request({ words: "OPEN" }), planned(request({ words: "OPEN" })));
  expect(String(body.prompt)).toContain('"OPEN"');
  expect(String(body.prompt)).toContain("Spell every word exactly as written");
  expect(body.size).toBe("1024x1024");
});
test("a minor's request goes to the old route as all-ages", () => {
  const req = request({ audience: "minor" });
  const plan = planMake(req, [ready("flux3-image-klein")].map((p) => p));
  expect(plan.ok).toBe(true);
  expect(pictureBody(req, plan as never).audience).toBe("all-ages");
});
test("the result carries the job id, the files and what it was made with", async () => {
  const sent: unknown[] = [];
  const result = await dispatchPicture(request(), planned(), async (path, body) => { sent.push([path, body]); return { status: 200, json: { job: "j1", data: [{ url: "/v1/images/generations/j1/0.png" }], notes: ["Steps are fixed at 16."] } }; });
  expect((sent[0] as [string])[0]).toBe("/v1/images/generations");
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ id: "j1", job: "picture", state: "done", percent: 100, files: ["/v1/images/generations/j1/0.png"], made_with: { part: "flux3-image-klein", pack_version: "1.0.0", sound: false, notes: ["Steps are fixed at 16."] } });
});
test("a refusal from the old route passes through unchanged", async () => {
  const result = await dispatchPicture(request(), planned(), async () => ({ status: 503, json: { error: "not installed", code: "not_installed" } }));
  expect(result).toEqual({ status: 503, body: { error: "not installed", code: "not_installed" } });
});

test("the route answers not_available when nothing that can do it is ready", async () => {
  const response = await app.request("/stack/v1/jobs/make", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request()) });
  expect(response.status).toBe(409);
  expect((await response.json() as { code: string }).code).toBe("not_available");
});
test("the route answers not_on_this_model for a named part that cannot do the job", async () => {
  const response = await app.request("/stack/v1/jobs/make", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request({ part: "ltx-2-5-q8-distilled-mlx" })) });
  expect(response.status).toBe(409);
  expect((await response.json() as { code: string }).code).toBe("not_on_this_model");
});
test("the catalog never calls an unwired job available", async () => {
  const catalog = await jobsCatalog("adult");
  for (const job of catalog.jobs) if (!["picture", "picture_edit", "clip", "song", "song_edit", "stems"].includes(job.job)) expect(job.available).toBe(false);
});

import { clipBody, dispatchClip, dispatchPictureEdit, INPUT_UNREADABLE_LINE, PICTURE_UNREADABLE_LINE, editFields } from "@/lib/makeDispatch";
import { sha256Hex } from "@/video/receipt";
const clipReq = (over: Partial<Extract<StackMakeRequest, { job: "clip" }>> = {}): Extract<StackMakeRequest, { job: "clip" }> => ({ job: "clip", audience: "adult", description: "a dog barks", shape: "landscape", level: "standard", seconds: 5, seed: 3, ...over });
const clipPlanned = (req = clipReq()) => { const p = planMake(req, [ready("ltx-2-5-q8-distilled-mlx"), ready("minimax-h3")]); if (!p.ok) throw new Error("not planned"); return p; };

test("a clip's old-route body comes from the pack: part id, the pack's pixel size, seconds, seed, the recipe's prompt (never its notes)", () => {
  const body = clipBody(clipReq(), clipPlanned());
  expect(body).toMatchObject({ model: "ltx-2-5-q8-distilled-mlx", size: "512x256", seconds: 5, seed: 3, audience: "adult", prompt: "a dog barks" });
  expect(String(body.prompt)).not.toContain("handheld");
});
test("a finished clip's result carries the job, the file, the poster, the sound and what it was made with", async () => {
  const result = await dispatchClip(clipReq(), clipPlanned(), async (path) => ({ status: 200, json: { job: "v1", data: [{ url: "/v1/videos/generations/v1/0.mp4", poster_url: "/v1/videos/generations/v1/0.jpg", seconds: 5, audio: true }] } }));
  expect(result.body).toMatchObject({ id: "v1", job: "clip", state: "done", files: ["/v1/videos/generations/v1/0.mp4"], poster: "/v1/videos/generations/v1/0.jpg", made_with: { part: "ltx-2-5-q8-distilled-mlx", seconds: 5, sound: true } });
});
test("a clip's result names its receipt by the job id (VF-RECEIPT-01)", async () => {
  const result = await dispatchClip(clipReq(), clipPlanned(), async () => ({ status: 200, json: { job: "v1", data: [{ url: "/v1/videos/generations/v1/0.mp4", poster_url: "/v1/videos/generations/v1/0.jpg", seconds: 5, audio: true }] } }));
  expect(result.body).toMatchObject({ made_with: { receipt: "v1" } });
});
test("the level is the clip's tier, the quiet window passes through and a caller that will not wait gets the job at once (VF-DOOR-01)", () => {
  const planned = (level: "standard" | "boost" | "max") => ({ ...clipPlanned(), level });
  expect(clipBody(clipReq(), planned("standard"))).not.toHaveProperty("tier");   // Standard keeps the untiered admission
  expect(clipBody(clipReq(), planned("boost"))).toMatchObject({ tier: "boost" });
  expect(clipBody(clipReq(), planned("max"))).toMatchObject({ tier: "max" });
  expect(clipBody(clipReq({ quiet_seconds: 60, quiet_max_wait_seconds: null, wait: 0 }), planned("max"))).toMatchObject({ quiet_seconds: 60, quiet_max_wait_seconds: null, timeout_ms: 1 });
  expect(clipBody(clipReq({ wait: 30 }), planned("standard"))).toMatchObject({ timeout_ms: 30_000 });
  expect(clipBody(clipReq(), planned("standard"))).not.toHaveProperty("timeout_ms");
});
const png = { bytes: new Uint8Array([137, 80, 78, 71]), type: "image/png" };
test("identity inputs without a reference row are refused before files are read", async () => {
  let sent: Record<string, unknown> = {};
  const request = clipReq({ inputs: [{ role: "identity", file: "/v1/images/generations/a/0.png" }, { role: "wardrobe", file: "/v1/images/generations/b/0.png" }], dialogue: [{ speaker: "sage", text: "I left it here." }], intent: "new_shot" });
  const result = await dispatchClip(request, clipPlanned(), async () => { throw new Error("must not forward"); }, async () => { throw new Error("must not read"); });
  expect(result).toEqual({ status: 422, body: { code: "needs_start_picture", line: "This model holds a person only from a first picture. Make one from the person's picture and send it as the start picture.", shape: "landscape", inputs: ["identity", "wardrobe"] } });
});
test("an input that cannot be read is refused plainly, never dropped", async () => {
  const refused = await dispatchClip(clipReq({ inputs: [{ role: "identity", file: "nope" }] }), clipPlanned(), async () => ({ status: 200, json: {} }), async () => null);
  expect(refused).toEqual({ status: 422, body: { code: "needs_start_picture", line: "This model holds a person only from a first picture. Make one from the person's picture and send it as the start picture.", shape: "landscape", inputs: ["identity"] } });
});
test("a clip with only start and end pictures still means the opening and closing frames, and sends no roles", async () => {
  let sent: Record<string, unknown> = {};
  await dispatchClip(clipReq({ start_picture: "/v1/images/generations/a/0.png", end_picture: "data:image/png;base64,AAAA" }), clipPlanned(), async (_p, body) => { sent = body as Record<string, unknown>; return { status: 200, json: { job: "v1", data: [] } }; }, async () => png);
  expect(typeof sent.image).toBe("string"); expect(typeof sent.end_image).toBe("string"); expect(sent.roles).toBeUndefined();
});
test("a clip that starts on a picture sends it to the runner as the first frame; an unreadable picture is refused plainly", async () => {
  let sent: Record<string, unknown> = {};
  await dispatchClip(clipReq({ start_picture: "/v1/images/generations/j/0.png", end_picture: "data:image/png;base64,AAAA" }), clipPlanned(), async (_p, body) => { sent = body as Record<string, unknown>; return { status: 200, json: { job: "v2", data: [] } }; }, async () => png);
  expect(String(sent.image)).toStartWith("data:image/png;base64,");
  expect(String(sent.end_image)).toStartWith("data:image/png;base64,");
  const refused = await dispatchClip(clipReq({ start_picture: "nope" }), clipPlanned(), async () => ({ status: 200, json: {} }), async () => null);
  expect(refused).toEqual({ status: 409, body: { code: "not_available", line: PICTURE_UNREADABLE_LINE } });
});
const editReq = (over: Partial<Extract<StackMakeRequest, { job: "picture_edit" }>> = {}): Extract<StackMakeRequest, { job: "picture_edit" }> => ({ job: "picture_edit", audience: "adult", picture: "/v1/images/generations/j/0.png", description: "make the sky pink", level: "standard", ...over });
test("a picture edit sends the picture, the pack's instruction and its references to the edits route and returns the edited file", async () => {
  const planned = planMake(editReq(), [ready("flux3-image-klein")]);
  if (!planned.ok) throw new Error("not planned");
  expect(editFields(editReq(), planned)).toMatchObject({ model: "flux3-image-klein", operation: "edit", instruction: "Change the given picture as described: make the sky pink. Keep everything else as it is." });
  let form: FormData | null = null;
  const done = await dispatchPictureEdit(editReq({ references: ["a", "b"] }), planned, async () => png, async (_p, f) => { form = f; return { status: 200, json: { job: "e1", data: [{ b64_json: "AAAA" }] } }; });
  expect(form!.get("image")).toBeInstanceOf(File);
  expect(form!.get("reference")).toBeInstanceOf(File);
  expect(form!.get("reference2")).toBeInstanceOf(File);
  expect(done.body).toMatchObject({ id: "e1", job: "picture_edit", state: "done", files: ["/v1/images/edits/e1"] });
  const refused = await dispatchPictureEdit(editReq(), planned, async () => null, async () => ({ status: 200, json: {} }));
  expect(refused.body).toEqual({ code: "not_available", line: PICTURE_UNREADABLE_LINE });
});
test("the catalog now lists clip as wired (available only when a part is ready)", async () => {
  const catalog = await jobsCatalog("adult");
  const clip = catalog.jobs.find((j) => j.job === "clip")!;
  expect(clip.available).toBe(false); // nothing is installed in the test environment
});

import { dispatchSong, dispatchSongEdit, dispatchStems, songBody, songEditBody, SONG_UNREADABLE_LINE } from "@/lib/makeDispatchAudio";
const musicPlan = (req: StackMakeRequest, id = "ace-step-1-5-turbo") => { const def = PART_DEFS.find((d) => d.id === id)!; const view = { id, kind: def.kind, category: def.category, priority: def.priority, label: def.label, description: "", enabled: true, state: "ready", size_bytes: 1, fits: { standard: true, boost: true, max: true, reason: null }, can_install: false, install_block: null, can_uninstall: true, uninstall_block: null, licence_needed: false, required_by: [], update: null } as unknown as StackPartView; const p = planMake(req, [view]); if (!p.ok) throw new Error("not planned"); return p; };
const m4a = { bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 77, 52, 65, 32]), type: "audio/mp4" };
test("a song becomes a text2music request: the pack's caption, quality from the level, instrumental when there are no lyrics", async () => {
  const req = { job: "song", audience: "adult", description: "a calm tune", style_words: ["piano"], seconds: 60 } as StackMakeRequest;
  const plan = musicPlan(req);
  expect(songBody(req as never, plan)).toMatchObject({ task: "text2music", caption: "a calm tune, piano", quality: "quick", instrumental: true, duration_s: 60 });
  let sent: unknown; const done = await dispatchSong(req as never, plan, async (_p, body) => { sent = body; return { status: 200, json: { job: "s1", data: [{ duration_s: 60, lrc: null }] } }; });
  expect(sent).toBeTruthy();
  expect(done.body).toMatchObject({ id: "s1", job: "song", state: "done", files: ["/v1/audio/music/s1/file"], made_with: { seconds: 60, sound: true } });
});
test("a song edit sends the song and the change; an unreadable song is refused plainly", async () => {
  const req = { job: "song_edit", audience: "adult", song: "/v1/audio/music/s1/file", change: { kind: "extend", add_seconds: 20, at: "end" } } as StackMakeRequest;
  const plan = musicPlan(req);
  expect(songEditBody(req as never, plan, "data:x")).toMatchObject({ task: "extend", add_s: 20, at: "end", source: "data:x" });
  let sent: Record<string, unknown> = {}; await dispatchSongEdit(req as never, plan, async () => m4a, async (_p, body) => { sent = body as never; return { status: 200, json: { job: "s2", data: [] } }; });
  expect(String(sent.source)).toStartWith("data:audio/mp4;base64,");
  expect((await dispatchSongEdit(req as never, plan, async () => null, async () => ({ status: 200, json: {} }))).body).toEqual({ code: "not_available", line: SONG_UNREADABLE_LINE });
});
test("stems keep only the parts asked for", async () => {
  const req = { job: "stems", audience: "adult", song: "/v1/audio/music/s1/file", stems: ["vocals"] } as StackMakeRequest;
  const plan = musicPlan(req, "htdemucs");
  const done = await dispatchStems(req as never, plan, async () => m4a, async () => ({ status: 200, json: { job: "t1", data: [{ stem: "vocals", url: "/v1/audio/stems/t1/vocals" }, { stem: "drums", url: "/v1/audio/stems/t1/drums" }] } }));
  expect(done.body).toMatchObject({ job: "stems", state: "done", stems: [{ name: "vocals", file: "/v1/audio/stems/t1/vocals" }], files: ["/v1/audio/stems/t1/vocals"] });
});

// VF-PROMPT-01: a pack whose clip recipe declares a prompt writer gets its engine's own prompt, written from the typed request; the writer and hints ride on the body.
test("an H3 clip's prompt is written in the official sectioned format from the structured dialogue, and the writer and hints go with it (never the text)", () => {
  const only = (id: string, req = clipReq()) => { const p = planMake(req, [ready(id)]); if (!p.ok) throw new Error(`not planned: ${JSON.stringify(p)}`); return p; };
  const req = clipReq({ description: "A woman sits at a kitchen table. There is no music.", dialogue: [{ speaker: "Ana", text: "It was my grandmother's." }], start_picture: "media-1" });
  const body = clipBody(req, only("minimax-h3", req));
  expect(String(body.prompt)).toBe(
    "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n"
    + "integrated_multimodal_description: [Shot 1] A woman sits at a kitchen table. For the first half second the scene is quiet and the speaker's lips are closed. The speaker Ana (S1), in a calm, warm, natural speaking voice with the lips forming each word, says: <d>[English] It was my grandmother's.</d>\n\n"
    + "overall_soundscape: Soft room tone continues under the scene.\n\nnon_diegetic_music: N/A");
  expect(body).toMatchObject({ prompt_writer: { id: "h3-sectioned", version: "1" }, prompt_hints: ["negation_removed:1", "start_picture_mouth_closed_advised"] });
});
test("an LTX Max clip's prompt is one paragraph with the line in quotes, and the film's look comes first, byte for byte, in every shot", () => {
  const only = (req: ReturnType<typeof clipReq>) => { const p = planMake(req, [ready("ltx-2-5-bf16-distilled-mlx-max")]); if (!p.ok) throw new Error("not planned"); return p; };
  const look = "Naturalistic digital drama at dusk, cool light from the window.";
  const a = clipReq({ level: "max", description: "A man waits by the door.", look }), b = clipReq({ level: "max", description: "A woman reads.", look, dialogue: [{ speaker: "Ana", text: "Leave the light on." }] });
  const first = String(clipBody(a, only(a)).prompt), second = String(clipBody(b, only(b)).prompt);
  expect(first.startsWith(`${look} A man waits by the door.`)).toBe(true);
  expect(second).toBe(`${look} A woman reads. Ana says quietly, with the lips parting only slightly, "Leave the light on." Quiet room tone fills the background.`);
  expect(first.slice(0, look.length)).toBe(second.slice(0, look.length));
  expect(clipBody(b, only(b))).toMatchObject({ prompt_writer: { id: "ltx-paragraph", version: "1" } });
});
test("a pack with no writer keeps the plain recipe and sends no writer fields", () => {
  const body = clipBody(clipReq(), clipPlanned());
  expect(body).not.toHaveProperty("prompt_writer"); expect(body).not.toHaveProperty("prompt_hints");
});
test("a clip whose words cannot be written is a plain 422, not a crash", async () => {
  const req = clipReq({ description: "There is no music. He is not smiling." });
  const result = await dispatchClip(req, (() => { const p = planMake(req, [ready("minimax-h3")]); if (!p.ok) throw new Error("not planned"); return p; })(), async () => ({ status: 200, json: {} }));
  expect(result.status).toBe(422); expect(result.body).toMatchObject({ code: "invalid_request" });
  expect(String((result.body as { line: string }).line)).toContain("positive words");
});
