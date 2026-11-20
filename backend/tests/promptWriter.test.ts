import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROMPT_WRITER_VERSIONS, type WriterData, type WriterInput, writePrompt, writerData } from "@/video/promptWriter";

const NEGATION = /\b(no|not|never|without|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|won't|can't|cannot|avoid|nothing|none|neither|nor)\b/i;
const packFile = (pack: string): string => readFileSync(join(import.meta.dir, "..", "src", "packs", pack, "recipes", "clip.md"), "utf8");
const H3_RECIPE = packFile("minimax-h3");
const LTX_RECIPE = packFile("ltx-2-5-bf16-distilled-mlx-max");

const H3: WriterData = {
  writer: "h3-sectioned",
  delivery: "a calm, warm, natural speaking voice with the lips forming each word",
  leadIn: "For the first half second the scene is quiet and the speaker's lips are closed.",
  soundscape: "Soft room tone continues under the scene.",
};
const LTX: WriterData = {
  writer: "ltx-paragraph",
  delivery: "quietly, with the lips parting only slightly",
  leadIn: "The scene is quiet for the first half second.",
  soundscape: "Quiet room tone fills the background.",
};

const DESCRIPTION = "A woman in her early thirties with wavy chestnut hair sits at a kitchen table in soft daylight.";
const base: WriterInput = { description: DESCRIPTION, dialogue: [{ speaker: "Ana", text: "It was my grandmother's." }], seconds: 5, startPicture: false, endPicture: false };

const H3_GOLDEN = `integrated_multimodal_description: [Shot 1] A woman in her early thirties with wavy chestnut hair sits at a kitchen table in soft daylight. For the first half second the scene is quiet and the speaker's lips are closed. The speaker Ana (S1), in a calm, warm, natural speaking voice with the lips forming each word, says: <d>[English] It was my grandmother's.</d>

overall_soundscape: Soft room tone continues under the scene.

non_diegetic_music: N/A`;
const I2VA = "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.";
const FL2VA = "How the reference pictures align with the target video \u2014 Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the 8.00-second mark of the target video.";
const L2VA = "How the reference pictures align with the target video \u2014 <Picture 1> (from [Shot 1]) aligns with the 5.00-second mark of the target video.";

describe("h3-sectioned", () => {
  test("text only, one line", () => {
    const out = writePrompt(base, H3);
    expect(out.text).toBe(H3_GOLDEN);
    expect(out.hints).toEqual([]);
    expect(out.writer).toEqual({ id: "h3-sectioned", version: PROMPT_WRITER_VERSIONS["h3-sectioned"] });
  });
  test("byte length is stable", () => {
    expect(Buffer.byteLength(H3_GOLDEN)).toBe(Buffer.byteLength(writePrompt(base, H3).text));
    expect(Buffer.byteLength(H3_GOLDEN)).toBe(450);
  });
  test("start picture", () => {
    const out = writePrompt({ ...base, startPicture: true }, H3);
    expect(out.text).toBe(`${I2VA}\n\n${H3_GOLDEN}`);
    expect(out.hints).toEqual(["start_picture_mouth_closed_advised"]);
  });
  test("start picture without dialogue gives no mouth hint", () => {
    expect(writePrompt({ ...base, dialogue: [], startPicture: true }, H3).hints).toEqual([]);
  });
  test("both pictures", () => {
    const out = writePrompt({ ...base, seconds: 8, startPicture: true, endPicture: true }, H3);
    expect(out.text).toBe(`${FL2VA}\n\n${H3_GOLDEN}`);
  });
  test("end picture only", () => {
    const out = writePrompt({ ...base, endPicture: true }, H3);
    expect(out.text).toBe(`${L2VA}\n\n${H3_GOLDEN}`);
    expect(out.hints).toEqual([]);
  });
  test("two speakers get stable ids and later lines start with Then", () => {
    const out = writePrompt({ ...base, dialogue: [{ speaker: "Ana", text: "One." }, { speaker: "Ben", text: "Two." }, { speaker: "Ana", text: "Three.", language: "Spanish" }] }, H3);
    expect(out.text).toContain("The speaker Ana (S1), in ");
    expect(out.text).toContain("</d> Then the speaker Ben (S2), in ");
    expect(out.text).toContain("</d> Then the speaker Ana (S1), in ");
    expect(out.text).toContain("<d>[Spanish] Three.</d>");
    expect(out.text.match(/Then /g)?.length).toBe(2);
  });
  test("no dialogue omits the lead-in", () => {
    const out = writePrompt({ ...base, dialogue: undefined }, H3);
    expect(out.text).toBe(`integrated_multimodal_description: [Shot 1] ${DESCRIPTION}\n\noverall_soundscape: Soft room tone continues under the scene.\n\nnon_diegetic_music: N/A`);
  });
});

describe("ltx-paragraph", () => {
  test("same input", () => {
    const out = writePrompt(base, LTX);
    expect(out.text).toBe(`${DESCRIPTION} Ana says quietly, with the lips parting only slightly, "It was my grandmother's." Quiet room tone fills the background.`);
    expect(out.hints).toEqual([]);
    expect(out.writer).toEqual({ id: "ltx-paragraph", version: "1" });
  });
  test("a line without end punctuation gets a period after the closing quote", () => {
    const out = writePrompt({ ...base, dialogue: [{ speaker: "Ana", text: "Come in" }] }, LTX);
    expect(out.text).toContain('"Come in". Quiet room tone');
  });
  test("one paragraph, no tags, no start-picture hint", () => {
    const out = writePrompt({ ...base, startPicture: true }, LTX);
    expect(out.text).not.toMatch(/[\n<>]/);
    expect(out.hints).toEqual([]);
  });
});

describe("negation", () => {
  const input: WriterInput = { description: "A man walks home. There is no music. He is not smiling. Rain falls.", dialogue: [{ speaker: "Ben", text: "I don't know." }], seconds: 5, startPicture: false, endPicture: false };
  for (const data of [H3, LTX]) {
    test(`${data.writer} drops negated sentences and keeps the words`, () => {
      const out = writePrompt(input, data);
      expect(out.text).not.toContain("no music");
      expect(out.text).not.toContain("not smiling");
      expect(out.text).toContain("A man walks home.");
      expect(out.text).toContain("Rain falls.");
      expect(out.text).toContain("I don't know.");
      expect(out.hints).toContain("negation_removed:2");
      const withoutDialogue = out.text.replace("I don't know.", "");
      expect(withoutDialogue).not.toMatch(NEGATION);
    });
  }
  test("fixed wording in both packs and the instruction lines has no negation", () => {
    for (const recipe of [H3_RECIPE, LTX_RECIPE]) {
      const data = writerData(recipe)!;
      for (const wording of [data.delivery, data.leadIn, data.soundscape]) expect(wording).not.toMatch(NEGATION);
    }
    for (const line of [I2VA, FL2VA, L2VA]) expect(line).not.toMatch(NEGATION);
    const lines = writePrompt({ ...base, seconds: 8, startPicture: true, endPicture: true }, H3).text.split("\n").slice(0, 1).join("");
    expect(lines).not.toMatch(NEGATION);
  });
  test("a description that is all negation and nothing else is refused with a fix", () => {
    expect(() => writePrompt({ ...base, description: "There is no music.", dialogue: [] }, H3)).toThrow(/positive words/);
  });
});

describe("look", () => {
  const look = "Naturalistic digital drama at dusk, cool light from the window, cream walls and walnut trim.";
  const shotA: WriterInput = { ...base, look, description: "Ana pours tea." };
  const shotB: WriterInput = { ...base, look, description: "Ben opens the door and steps inside.", dialogue: [] };
  test("h3 puts the look right after the shot prefix, byte for byte", () => {
    const prefix = "integrated_multimodal_description: [Shot 1] ";
    const a = writePrompt(shotA, H3).text;
    const b = writePrompt(shotB, H3).text;
    expect(a.indexOf(look)).toBe(prefix.length);
    expect(b.indexOf(look)).toBe(prefix.length);
    expect(a.slice(0, prefix.length + look.length + 1)).toBe(b.slice(0, prefix.length + look.length + 1));
    expect(a.slice(prefix.length, prefix.length + look.length + 1)).toBe(`${look} `);
  });
  test("ltx puts the look first, byte for byte", () => {
    const a = writePrompt(shotA, LTX).text;
    const b = writePrompt(shotB, LTX).text;
    expect(a.indexOf(look)).toBe(0);
    expect(b.indexOf(look)).toBe(0);
    expect(a.slice(0, look.length + 1)).toBe(`${look} `);
    expect(a.slice(0, look.length + 1)).toBe(b.slice(0, look.length + 1));
  });
  test("a look keeps its exact characters when it has no negation (the double space inside it survives)", () => {
    const odd = "Warm  light, soft shadows.";
    expect(writePrompt({ ...base, look: odd }, LTX).text.startsWith(`Warm  light, soft shadows. `)).toBe(true);
  });
});

describe("writerData", () => {
  test("the real pack files parse to the pack data", () => {
    expect(writerData(H3_RECIPE)).toEqual(H3);
    expect(writerData(LTX_RECIPE)).toEqual(LTX);
  });
  test("no writer line returns null", () => {
    expect(writerData("{description}\n---measured---\nA measured note.")).toBeNull();
    expect(writerData("{description}")).toBeNull();
  });
  test("an unknown writer id throws and names the file", () => {
    expect(() => writerData("{description}\n---measured---\nwriter: sparkle\ndelivery: a\nlead_in: b\nsoundscape: c")).toThrow(/recipes\/clip\.md/);
  });
  test("a missing line throws and names the file", () => {
    expect(() => writerData("{description}\n---measured---\nwriter: h3-sectioned\nlead_in: b\nsoundscape: c")).toThrow(/delivery.*recipes\/clip\.md|recipes\/clip\.md.*delivery/);
    expect(() => writerData("{description}\n---measured---\nwriter: h3-sectioned\ndelivery: a\nsoundscape: c")).toThrow(/lead_in/);
    expect(() => writerData("{description}\n---measured---\nwriter: h3-sectioned\ndelivery: a\nlead_in: b")).toThrow(/soundscape/);
  });
});

describe("empty input", () => {
  test("no description and no dialogue throws", () => {
    for (const data of [H3, LTX]) {
      expect(() => writePrompt({ ...base, description: "  ", dialogue: [] }, data)).toThrow("A clip needs a description or a line of dialogue.");
    }
  });
  test("dialogue only works", () => {
    const h3 = writePrompt({ ...base, description: "" }, H3).text;
    expect(h3.startsWith("integrated_multimodal_description: [Shot 1] For the first half second")).toBe(true);
    expect(writePrompt({ ...base, description: "" }, LTX).text).toBe(`Ana says quietly, with the lips parting only slightly, "It was my grandmother's." Quiet room tone fills the background.`);
  });
});

describe("the look paragraph is filtered by the same rule and stays byte-identical", () => {
  const dataH3 = writerData(readFileSync(new URL("../src/packs/minimax-h3/recipes/clip.md", import.meta.url), "utf8"))!;
  test("a negation in the look is removed the same way in every shot", () => {
    const look = "Naturalistic dusk. There is no haze. Cream walls and walnut trim.";
    const a = writePrompt({ description: "A woman reads.", seconds: 5, startPicture: false, endPicture: false, look }, dataH3);
    const b = writePrompt({ description: "A man waits.", seconds: 5, startPicture: false, endPicture: false, look }, dataH3);
    const lookOut = "Naturalistic dusk. Cream walls and walnut trim.";
    expect(a.text).toContain(`[Shot 1] ${lookOut} A woman reads.`); expect(b.text).toContain(`[Shot 1] ${lookOut} A man waits.`);
    expect(a.hints).toContain("negation_removed:1");
  });
});
