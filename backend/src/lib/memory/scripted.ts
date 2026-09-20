import os from "node:os";
import type { MemoryReader, MemorySnapshot } from "@/lib/memory/types";

type ScriptedReading = MemorySnapshot | { probeError: string };

export function scriptedMemoryReader(readings: ScriptedReading[], footprints: Record<number, number | null> = {}): MemoryReader {
  let index = 0;
  let previous: MemorySnapshot | null = null;
  const defaultGood: MemorySnapshot = { totalBytes: 16 * 1_073_741_824, availablePercent: 50, pressure: "normal", freeBytes: 8 * 1_073_741_824, degraded: false };
  return {
    read: () => {
      const scripted = readings[Math.min(index++, Math.max(0, readings.length - 1))] ?? defaultGood;
      if ("probeError" in scripted) {
        if (previous) return { ...previous, degraded: true, probeError: scripted.probeError };
        return { totalBytes: os.totalmem(), availablePercent: 0, pressure: "normal", freeBytes: os.totalmem(), degraded: true, probeError: scripted.probeError };
      }
      const reading = { ...(scripted as MemorySnapshot), degraded: (scripted as MemorySnapshot).degraded ?? false };
      previous = reading;
      return { ...previous };
    },
    processFootprint: (pid) => footprints[pid] ?? null,
  };
}
