// MODELPACK-JOBS-01, the music family: song, song_edit and stems go to the existing music and stems routes in this process, the same way
// pictures and clips do (makeDispatch.ts). A song to change or split is a file this Stack already served (a path under /v1/) or a data: URL.
import { createHash } from "node:crypto";
import type { StackMakeRequest, StackMakeResult } from "@maipai/spec/stack/ts/stack-make.js";
import type { MakePlan } from "@/lib/makePlan";
import { fillRecipe } from "@/lib/recipe";
import type { PictureBytes } from "@/lib/makeDispatch";

type Planned = Extract<MakePlan, { ok: true }>;
type Forward = (path: string, body: unknown) => Promise<{ status: number; json: unknown }>;
type SongRequest = Extract<StackMakeRequest, { job: "song" }>;
type SongEditRequest = Extract<StackMakeRequest, { job: "song_edit" }>;
type StemsRequest = Extract<StackMakeRequest, { job: "stems" }>;

export const SONG_UNREADABLE_LINE = "That song could not be found. Send a song a job just made here, or a data: URL of it.";
const QUALITY = { standard: "quick", boost: "detailed", max: "max" } as const;
const unreadable = { status: 409, body: { code: "not_available", line: SONG_UNREADABLE_LINE } };

const caption = (request: { description?: string; style_words?: string[] }, plan: Planned): string => {
  const recipe = plan.serving.pack.recipes[plan.serving.job.recipe] ?? "{description}";
  const base = request.description ? fillRecipe(recipe, { description: request.description }) : "";
  return [base, ...(request.style_words ?? [])].filter(Boolean).join(", ");
};

export function songBody(request: SongRequest, plan: Planned): Record<string, unknown> {
  return {
    task: "text2music", caption: caption(request, plan), quality: QUALITY[plan.level],
    ...(request.lyrics ? { lyrics: request.lyrics } : { instrumental: true }), duration_s: Math.round(request.seconds), ...(request.seed !== undefined ? { seed: request.seed } : {}),
  };
}

function songResult(job: "song" | "song_edit", plan: Planned, reply: { job: string; data?: Array<{ duration_s: number; lrc: string | null }> }): StackMakeResult {
  const first = reply.data?.[0];
  return {
    id: reply.job, job, state: first ? "done" : "running", percent: first ? 100 : 0, status: first ? "Done" : job === "song" ? "Making your song" : "Changing your song",
    files: first ? [`/v1/audio/music/${reply.job}/file`] : [], poster: null,
    made_with: { part: plan.serving.part.id, label: plan.serving.part.label, pack_version: plan.serving.pack.pack.version, shape: null, seconds: first?.duration_s ?? null, sound: true, notes: [] },
  };
}

export async function dispatchSong(request: SongRequest, plan: Planned, forward: Forward): Promise<{ status: number; body: unknown }> {
  const sent = await forward("/v1/audio/music", songBody(request, plan));
  if (sent.status !== 200 && sent.status !== 202) return { status: sent.status, body: sent.json };
  return { status: sent.status, body: songResult("song", plan, sent.json as never) };
}

export function songEditBody(request: SongEditRequest, plan: Planned, source: string): Record<string, unknown> {
  const change = request.change;
  const common = { source, quality: QUALITY[plan.level] };
  if (change.kind === "cover") return { ...common, task: "cover", caption: (change.style_words ?? []).join(", "), ...(change.strength !== undefined ? { strength: change.strength } : {}) };
  if (change.kind === "repaint") return { ...common, task: "repaint", from_s: change.from_seconds, to_s: change.to_seconds, ...(change.description ? { caption: change.description } : {}), ...(change.lyrics ? { lyrics: change.lyrics } : {}) };
  return { ...common, task: "extend", add_s: Math.round(change.add_seconds), ...(change.at ? { at: change.at } : {}) };
}

export async function dispatchSongEdit(request: SongEditRequest, plan: Planned, read: PictureBytes, forward: Forward): Promise<{ status: number; body: unknown }> {
  const song = await read(request.song);
  if (!song) return unreadable;
  const sent = await forward("/v1/audio/music", songEditBody(request, plan, `data:audio/mp4;base64,${Buffer.from(song.bytes).toString("base64")}`));
  if (sent.status !== 200 && sent.status !== 202) return { status: sent.status, body: sent.json };
  return { status: sent.status, body: songResult("song_edit", plan, sent.json as never) };
}

/** The splitter makes every stem its model knows; the request names the ones it wants and the rest are dropped from the answer. */
export async function dispatchStems(request: StemsRequest, plan: Planned, read: PictureBytes, forward: Forward): Promise<{ status: number; body: unknown }> {
  const song = await read(request.song);
  if (!song) return unreadable;
  const sent = await forward("/v1/audio/stems", { source: Buffer.from(song.bytes).toString("base64"), source_sha256: createHash("sha256").update(song.bytes).digest("hex"), model: "htdemucs" });
  if (sent.status !== 200 && sent.status !== 202) return { status: sent.status, body: sent.json };
  const reply = sent.json as { job: string; data?: Array<{ stem: string; url: string }> };
  const wanted = new Set(request.stems);
  const stems = (reply.data ?? []).filter((item) => wanted.has(item.stem)).map((item) => ({ name: item.stem, file: item.url }));
  const done = (reply.data?.length ?? 0) > 0;
  if (done && stems.length === 0) return { status: 409, body: { code: "not_available", line: `This model splits a song into ${(reply.data ?? []).map((i) => i.stem).join(", ")}. None of the parts you asked for are among them.` } };
  const result: StackMakeResult = {
    id: reply.job, job: "stems", state: done ? "done" : "running", percent: done ? 100 : 0, status: done ? "Done" : "Splitting your song", files: stems.map((s) => s.file), poster: null, stems,
    made_with: { part: plan.serving.part.id, label: plan.serving.part.label, pack_version: plan.serving.pack.pack.version, shape: null, seconds: null, sound: true, notes: [] },
  };
  return { status: sent.status, body: result };
}
