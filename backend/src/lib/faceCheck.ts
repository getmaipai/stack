import type { referenceClipRules } from "@/packs/loader";

export interface FaceTools {
  faces(image: Uint8Array): Promise<Array<{ vec: Float32Array }> | null>;
  cosine(a: Float32Array, b: Float32Array): number;
}

type Rules = NonNullable<ReturnType<typeof referenceClipRules>>;
export type FacePerson = { index: number; score: number | null; pass: boolean };
export type FirstPictureReceipt = { redraws: number; people: FacePerson[] };
export type ClipFaceReceipt = { frames: number; people: Array<{ index: number; median: number | null; low: boolean }> };

export async function scoreFirstPicture(candidate: Uint8Array, photoVecs: Array<Float32Array | null>, rules: Rules, tools: FaceTools): Promise<{ ok: boolean; people: FacePerson[] }> {
  const found = await tools.faces(candidate).catch(() => null);
  const people = photoVecs.map((photo, index) => {
    const score = photo && found?.length ? found.reduce((best, face) => Math.max(best, tools.cosine(photo, face.vec)), -1) : null;
    return { index, score, pass: score !== null && score >= rules.face_gate };
  });
  return { ok: people.every((person) => person.pass), people };
}

function abortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export async function runFirstPictureLoop({ photoVecs, rules, tools, draw }: {
  photoVecs: Array<Float32Array | null>; rules: Rules; tools: FaceTools; draw(attempt: number): Promise<Uint8Array>;
}): Promise<{ ok: true; picture: Uint8Array; receipt: FirstPictureReceipt } | { ok: false; refusal: { code: "input_not_supported"; line: string }; receipt: FirstPictureReceipt }> {
  let finalPeople: FacePerson[] = photoVecs.map((_, index) => ({ index, score: null, pass: false }));
  for (let attempt = 0; attempt <= rules.redraws; attempt++) {
    let picture: Uint8Array;
    try {
      picture = await draw(attempt);
    } catch (error) {
      if (abortError(error)) throw error;
      finalPeople = photoVecs.map((_, index) => ({ index, score: null, pass: false }));
      continue;
    }
    const result = await scoreFirstPicture(picture, photoVecs, rules, tools);
    finalPeople = result.people;
    if (result.ok) return { ok: true, picture, receipt: { redraws: attempt, people: finalPeople } };
  }
  return { ok: false, refusal: { code: "input_not_supported", line: "The faces in the picture could not be matched to the photos. Try different photos or try again." }, receipt: { redraws: rules.redraws, people: finalPeople } };
}

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const round3 = (value: number) => Math.round(value * 1000) / 1000;

export async function measureClipFaces({ frames, photoVecs, rules, tools }: {
  frames: Uint8Array[]; photoVecs: Array<Float32Array | null>; rules: Rules; tools: FaceTools;
}): Promise<ClipFaceReceipt | null> {
  if (!photoVecs.some((photo) => photo !== null)) return null;
  const scores = photoVecs.map(() => [] as number[]);
  let measured = 0;
  try {
    for (const frame of frames) {
      const found = await tools.faces(frame);
      if (found === null) return null;
      if (!found.length) continue;
      measured++;
      photoVecs.forEach((photo, index) => {
        if (photo) scores[index]!.push(round3(found.reduce((best, face) => Math.max(best, tools.cosine(photo, face.vec)), -1)));
      });
    }
  } catch { return null; }
  return { frames: measured, people: photoVecs.map((_, index) => {
    const value = median(scores[index]!);
    const rounded = value === null ? null : round3(value);
    return { index, median: rounded, low: rounded !== null && rounded < rules.clip_face_low };
  }) };
}

export function faceCheckReceipt({ rules, first, clip }: { rules: Rules; first?: FirstPictureReceipt; clip?: ClipFaceReceipt }) {
  return { gate: rules.face_gate, low: rules.clip_face_low, ...(first ? { first_picture: first } : {}), ...(clip ? { clip } : {}) };
}
