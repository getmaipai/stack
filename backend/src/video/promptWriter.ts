// VF-PROMPT-01: the per-engine clip prompt writer. A pure function that turns the typed clip request into the prompt text one engine wants,
// driven by the pack's recipes/clip.md data lines. Home never writes an engine's prompt. Not wired into dispatch yet.
import { parseRecipe } from "@/lib/recipe";

export type PromptWriterId = "h3-sectioned" | "ltx-paragraph";
export const PROMPT_WRITER_VERSIONS: Record<PromptWriterId, string> = { "h3-sectioned": "1", "ltx-paragraph": "1" };

export interface WriterDialogue { speaker: string; text: string; language?: string | undefined }
export interface WriterInput {
  description: string;
  dialogue?: readonly WriterDialogue[] | undefined;
  seconds: number;
  startPicture: boolean;
  endPicture: boolean;
  /** The film's look paragraph: put first and repeated byte for byte in every shot. */
  look?: string | undefined;
}
export interface WriterData { writer: PromptWriterId; delivery: string; leadIn: string; soundscape: string }
export interface WrittenPrompt { text: string; writer: { id: PromptWriterId; version: string }; hints: string[] }

const WRITER_IDS: readonly PromptWriterId[] = ["h3-sectioned", "ltx-paragraph"];
const NEGATION = /\b(no|not|never|without|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|won't|can't|cannot|avoid|nothing|none|neither|nor)\b/i;
const CLIP_MD = "recipes/clip.md";

/** Reads the `name: value` lines after `---measured---`. Null when there is no `writer:` line (the legacy passthrough stays). */
export function writerData(recipeText: string): WriterData | null {
  const { measured } = parseRecipe(recipeText);
  const values = new Map<string, string>();
  for (const line of (measured ?? "").split("\n")) {
    const match = /^(writer|delivery|lead_in|soundscape):[ \t]*(.*)$/.exec(line.trim());
    if (match) values.set(match[1]!, match[2]!.trim());
  }
  const writer = values.get("writer");
  if (writer === undefined) return null;
  if (!(WRITER_IDS as readonly string[]).includes(writer)) {
    throw new Error(`The writer line in ${CLIP_MD} names "${writer}", which is not a known prompt writer. Change it to one of: ${WRITER_IDS.join(", ")}.`);
  }
  for (const key of ["delivery", "lead_in", "soundscape"] as const) {
    if (!values.get(key)) throw new Error(`${CLIP_MD} has a writer line but no ${key}: line. Add a "${key}: ..." line after the ---measured--- marker.`);
  }
  return { writer: writer as PromptWriterId, delivery: values.get("delivery")!, leadIn: values.get("lead_in")!, soundscape: values.get("soundscape")! };
}

const twoDecimals = (seconds: number): string => seconds.toFixed(2);

/** The first-frame or first-and-last-frame instruction line, or null for a text-only clip. */
function instructionLine(input: WriterInput): string | null {
  const end = twoDecimals(input.seconds);
  if (input.startPicture && input.endPicture) {
    return `How the reference pictures align with the target video \u2014 Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the ${end}-second mark of the target video.`;
  }
  if (input.startPicture) return "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.";
  if (input.endPicture) return `How the reference pictures align with the target video \u2014 <Picture 1> (from [Shot 1]) aligns with the ${end}-second mark of the target video.`;
  return null;
}

/** Drops every description sentence that carries a negation. Dialogue is never passed through here. */
function keptSentences(description: string): { sentences: string[]; dropped: number } {
  const all = description.trim().split(/(?<=[.!?])(?:\s+|$)/).map((s) => s.trim()).filter((s) => s !== "");
  const sentences = all.filter((s) => !NEGATION.test(s));
  return { sentences, dropped: all.length - sentences.length };
}

export function writePrompt(input: WriterInput, data: WriterData): WrittenPrompt {
  const lines = (input.dialogue ?? []).filter((line) => line.text.trim() !== "");
  if (input.description.trim() === "" && lines.length === 0) throw new Error("A clip needs a description or a line of dialogue.");
  const { sentences, dropped } = keptSentences(input.description);
  // The look paragraph is filtered by the same rule, deterministically, so it stays byte-identical from shot to shot.
  const lookParts = input.look !== undefined && input.look !== "" ? keptSentences(input.look) : null;
  const look = lookParts !== null && lookParts.sentences.length > 0 ? lookParts.sentences.join(" ") : null;
  if (sentences.length === 0 && lines.length === 0 && look === null) {
    throw new Error("Every sentence of the description was a negation and was removed. Describe what the clip shows in positive words and try again.");
  }

  const ids = new Map<string, string>();
  const speakerId = (name: string): string => {
    let id = ids.get(name);
    if (id === undefined) { id = `S${ids.size + 1}`; ids.set(name, id); }
    return id;
  };
  const hints = new Set<string>();
  const droppedTotal = dropped + (lookParts?.dropped ?? 0);
  if (droppedTotal > 0) hints.add(`negation_removed:${droppedTotal}`);

  const head: string[] = [...(look !== null ? [look] : []), ...sentences];
  let text: string;
  if (data.writer === "h3-sectioned") {
    const pieces = [...head];
    if (lines.length > 0) {
      pieces.push(data.leadIn);
      lines.forEach((line, index) => {
        const phrase = `the speaker ${line.speaker} (${speakerId(line.speaker)})`;
        const spoken = `${phrase}, in ${data.delivery}, says: <d>[${line.language?.trim() || "English"}] ${line.text}</d>`;
        pieces.push(index === 0 ? `T${spoken.slice(1)}` : `Then ${spoken}`);
      });
      if (input.startPicture) hints.add("start_picture_mouth_closed_advised");
    }
    const instruction = instructionLine(input);
    text = [
      ...(instruction !== null ? [instruction] : []),
      `integrated_multimodal_description: ${["[Shot 1]", ...pieces].join(" ")}`,
      `overall_soundscape: ${data.soundscape}`,
      "non_diegetic_music: N/A",
    ].join("\n\n");
  } else {
    const pieces = [...head];
    for (const line of lines) {
      speakerId(line.speaker);
      const closing = /[.!?\u2026]["'\u201d\u2019)\]]*$/.test(line.text) ? "" : ".";
      pieces.push(`${line.speaker} says ${data.delivery}, "${line.text}"${closing}`);
    }
    pieces.push(data.soundscape);
    text = pieces.join(" ");
  }
  return { text, writer: { id: data.writer, version: PROMPT_WRITER_VERSIONS[data.writer] }, hints: [...hints].sort() };
}
