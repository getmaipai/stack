// Host-wide CPU utilization for the resource history sampler
// (lib/series.ts), distinct from live.ts's cpu.percent, which is the chat
// engine process's own %CPU. Computed from two node:os.cpus() snapshots
// (busy time delta over total time delta, across every core), so it needs
// no new subprocess and works the same on every platform.
import os from "node:os";

interface CpuTotals { idle: number; total: number; }

function readTotals(): CpuTotals {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

let reader: () => CpuTotals = readTotals;
let previous: CpuTotals | null = null;

export function __setHostCpuReaderForTests(next: () => CpuTotals): void {
  reader = next;
}

export function __resetHostCpuForTests(): void {
  reader = readTotals;
  previous = null;
}

// Null on the first call (and after a reset): there is no earlier snapshot
// yet to take a delta against, so nothing is fabricated for that sample.
export function hostCpuPercent(): number | null {
  const current = reader();
  const last = previous;
  previous = current;
  if (!last) return null;
  const idleDelta = current.idle - last.idle;
  const totalDelta = current.total - last.total;
  if (totalDelta <= 0) return null;
  const busyDelta = totalDelta - idleDelta;
  return Math.max(0, Math.min(100, (busyDelta / totalDelta) * 100));
}
