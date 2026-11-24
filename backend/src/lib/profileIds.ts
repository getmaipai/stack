import { z } from "zod";
import rows from "@/rows/templateRows.json";

/** Hardware template ids, in size order. They come from rows/templateRows.json: code never lists them. */
export const PROFILE_IDS = rows.map((row) => row.id) as [string, ...string[]];
export type ProfileId = string;
export const ProfileIdSchema = z.enum(PROFILE_IDS);
/** Size rank of a template (smallest is 0); -1 for an unknown id. */
export function profileRank(id: string): number { return PROFILE_IDS.indexOf(id); }

/** Behavior fields of a template row (rows/templateRows.json). Code reads these, never the template id. */
export interface TemplateBehavior {
  id: string;
  workingMarginGb: number;
  matchCeilingGb: number;
  minUnifiedGb: number;
  /** Speech-to-text uses the small model on this template. */
  smallSpeech: boolean;
  reducedVoicePeakBytes: number;
  recordedSpeech: boolean;
  heavyLaneSlots: number;
  /** The picture generator can run here. */
  pictures: boolean;
  defaultTts: string;
}
const BEHAVIOR = rows as unknown as TemplateBehavior[];
/** The behavior row of a template; an unknown id gets the smallest template's row. */
export function templateBehavior(id: string): TemplateBehavior { return BEHAVIOR.find((row) => row.id === id) ?? BEHAVIOR[0]!; }
/** The smallest and the largest template id. */
export const SMALLEST_PROFILE: string = PROFILE_IDS[0];
export const LARGEST_PROFILE: string = PROFILE_IDS[PROFILE_IDS.length - 1]!;

/** A template's working margin in bytes (GiB, as the governor counts). */
export function workingMarginBytes(id: string): number { return templateBehavior(id).workingMarginGb * 1_073_741_824; }
