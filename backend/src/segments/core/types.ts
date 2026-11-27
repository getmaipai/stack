// Compatibility type aliases for Stack-only algorithms; record definitions live in commons spec.
export type { Range, MediaSegment as MediaSegmentT, MediaSegmentsRecord as MediaSegmentsRecordT } from "@maipai/spec/media/ts/segments";
export type SegmentKindT = import("@maipai/spec/media/ts/segments").MediaSegment["kind"];
export type SegmentSourceT = import("@maipai/spec/media/ts/segments").MediaSegment["source"];
export type SegmentStatusT = import("@maipai/spec/media/ts/segments").MediaSegment["status"];
