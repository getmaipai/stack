// UNITMETA-01: the five video units read their group, role and tiers from
// rows/unitMeta.json through the unitMeta helper instead of literals in the
// push calls. The units are found in the real component list the way
// components.test.ts does (the override cleared, then the defs read).
import { expect, test } from "bun:test";
import { __setComponentUnitsForTests, componentDefs, unitMeta, type UnitDef } from "@/lib/components";
import { STACK_VIDEO_H3_MODEL_ID, STACK_VIDEO_LTX25_MAX_MODEL_ID, STACK_VIDEO_LTX25_MODEL_ID, STACK_VIDEO_MASK_MODEL_ID, STACK_VIDEO_MODELS } from "@/lib/modelCatalog";

const VIDEO_UNIT_IDS = [STACK_VIDEO_MODELS[0]!.id, STACK_VIDEO_LTX25_MODEL_ID, STACK_VIDEO_H3_MODEL_ID, STACK_VIDEO_LTX25_MAX_MODEL_ID, STACK_VIDEO_MASK_MODEL_ID];
const EXPECTED_TIERS: NonNullable<UnitDef["tiers"]>[] = [["p128"], ["p128"], ["p16", "p32", "p64", "p128"], ["p128"], ["p64", "p128"]];

test("the five video units keep group video, role video and their original tiers from the metadata rows", () => {
  __setComponentUnitsForTests(null);
  const units = componentDefs();
  const expected = VIDEO_UNIT_IDS.map((id, index) => ({ id, group: "video" as const, role: "video", tiers: EXPECTED_TIERS[index]! }));
  const found = units.filter((unit) => VIDEO_UNIT_IDS.includes(unit.id)).map((unit) => ({ id: unit.id, group: unit.group, role: unit.role, tiers: unit.tiers }));
  expect(found).toEqual(expected);
});

test("unitMeta throws for an id with no metadata row", () => {
  expect(() => unitMeta("no-such-unit")).toThrow("no unit metadata for no-such-unit");
});

const MUSIC_META = [
  { id: "ace-step-1-5-turbo", tiers: ["p64", "p128"] },
  { id: "stable-audio-3-small-sfx", tiers: ["p32", "p64", "p128"] },
  { id: "score-gen", tiers: ["p16", "p32", "p64", "p128"] },
  { id: "whisper-large-v3-turbo", tiers: ["p64", "p128"] },
  { id: "ace-step-1-5-xl-turbo-bf16", tiers: ["p128"] },
  { id: "ace-step-1-5-xl-sft-bf16", tiers: ["p128"] },
];

test("the six music units have metadata rows with group music, role music and their tiers", () => {
  for (const row of MUSIC_META) expect(unitMeta(row.id)).toEqual({ group: "music", role: "music", tiers: row.tiers as never });
});

const OTHER_META: Array<{ id: string; group: string; role: string; tiers?: string[] }> = [
  { id: "wakeword", group: "voice", role: "wakeword" },
  { id: "seedvr2-3b", group: "tools", role: "image", tiers: ["p64", "p128"] },
  { id: "image-tools", group: "tools", role: "image" },
  { id: "ffmpeg", group: "tools", role: "media" },
  { id: "fpcalc", group: "tools", role: "media" },
  { id: "shazam-signature", group: "tools", role: "media" },
  { id: "liveportrait", group: "tools", role: "image" },
  { id: "tool-look", group: "tools", role: "image" },
  { id: "htdemucs", group: "stems", role: "music" },
  { id: "htdemucs-ft", group: "stems", role: "music" },
  { id: "htdemucs-6s", group: "stems", role: "music" },
  { id: "mms-fa-align", group: "stems", role: "music" },
  { id: "beats-analysis", group: "stems", role: "music" },
  { id: "soulx-singer-svc", group: "stems", role: "music" },
  { id: "mossformer2-se-48k", group: "voice", role: "tts" },
  { id: "fish-audio-drama-3-4bit", group: "voice", role: "tts", tiers: ["p64", "p128"] },
];

test("the stem, voice, wake word and tool units have metadata rows with their group, role and tiers", () => {
  for (const row of OTHER_META) expect(unitMeta(row.id)).toEqual({ group: row.group, role: row.role, ...(row.tiers ? { tiers: row.tiers } : {}) } as never);
});
