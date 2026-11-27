// Mirrors planned @maipai/spec media-segments; swap when released.
import { z } from "zod";

export const SEGMENT_KINDS = ["ad", "sponsor", "selfpromo", "intro", "outro", "recap", "filler", "bumper"] as const;
export const SEGMENT_SOURCES = ["fingerprint", "text-pattern", "llm", "alignment", "person", "chapter", "bumper"] as const;
export const SEGMENT_STATUSES = ["auto", "held", "confirmed", "rejected"] as const;

export const SegmentKind = z.enum(SEGMENT_KINDS);
export const SegmentSource = z.enum(SEGMENT_SOURCES);
export const SegmentStatus = z.enum(SEGMENT_STATUSES);

export const MediaSegment = z.object({
  id: z.string().min(1),
  kind: SegmentKind,
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  confidence: z.number().min(0).max(1),
  /** Primary source (the one behind the highest confidence). */
  source: SegmentSource,
  /** Union of every source that agreed, filled by normalizeSegments. */
  sources: z.array(SegmentSource).optional(),
  status: SegmentStatus,
  label: z.string().optional(),
  slotRole: z.enum(["lead-stinger", "slot", "tail-stinger"]).optional(),
  groupId: z.string().optional(),
}).refine((s) => s.endSec > s.startSec, { message: "endSec must be greater than startSec" });

export const ProducedBy = z.object({
  transcriptRevision: z.string().min(1),
  modelId: z.string().min(1),
  pipelineVersion: z.string().min(1),
  createdAt: z.string().min(1),
});

export const MediaSegmentsRecord = z.object({
  fileSha256: z.string().regex(/^[0-9a-f]{64}$/i),
  durationSec: z.number().positive(),
  segments: z.array(MediaSegment),
  producedBy: ProducedBy,
});

export type SegmentKindT = z.infer<typeof SegmentKind>;
export type SegmentSourceT = z.infer<typeof SegmentSource>;
export type SegmentStatusT = z.infer<typeof SegmentStatus>;
export type MediaSegmentT = z.infer<typeof MediaSegment>;
export type MediaSegmentsRecordT = z.infer<typeof MediaSegmentsRecord>;

/** A plain time range in seconds of the original file. */
export interface Range {
  startSec: number;
  endSec: number;
}
