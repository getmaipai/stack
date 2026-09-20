export type MemoryPressure = "normal" | "warn" | "critical";

export interface MemorySnapshot {
  totalBytes: number;
  availablePercent: number;
  pressure: MemoryPressure;
  freeBytes: number;
  degraded: boolean;
  probeError?: string;
}

export interface MemoryReader {
  read(): MemorySnapshot;
  processFootprint(pid: number): number | null;
}
