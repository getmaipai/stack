import type { MemorySnapshot } from "@/lib/memory/types";

// The one definition of the suite's default, host-independent memory
// reading (tests/preload.ts sets it, memoryReader.test.ts and
// supervisor.test.ts restore it after opting out for a real-reader
// test) so the three can't drift out of sync with each other.
const GB = 1_073_741_824;
export const GOVERNOR_MEMORY_DEFAULT: MemorySnapshot = { totalBytes: 128 * GB, freeBytes: 64 * GB, availablePercent: 50, pressure: "normal" };
