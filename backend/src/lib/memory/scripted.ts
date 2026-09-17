import type { MemoryReader, MemorySnapshot } from "@/lib/memory/types";

export function scriptedMemoryReader(readings: MemorySnapshot[], footprints: Record<number, number | null> = {}): MemoryReader {
  let index = 0;
  const first = readings[0] ?? { totalBytes: 16 * 1_073_741_824, availablePercent: 50, pressure: "normal", freeBytes: 8 * 1_073_741_824 };
  return {
    read: () => {
      const reading = readings[Math.min(index++, Math.max(0, readings.length - 1))] ?? first;
      return { ...reading };
    },
    processFootprint: (pid) => footprints[pid] ?? null,
  };
}
