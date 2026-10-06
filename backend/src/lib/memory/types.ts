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
  /** The memory one process holds, the one figure behind every measured
   * peak, the post-load measurement and the runaway watch: its resident
   * set including the model weights it memory-maps, and never less than
   * the kernel's own charge for it. macOS: the larger of the resident
   * size and the physical footprint (`proc_pid_rusage`), falling back to
   * `ps -o rss=`. Linux: `VmRSS`, which already counts mapped files.
   * Null when the process cannot be read. */
  processMemoryBytes(pid: number): number | null;
}
