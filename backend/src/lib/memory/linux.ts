import { readFileSync } from "node:fs";
import os from "node:os";
import { raiseRepair } from "@/lib/repairs";
import type { MemoryReader, MemoryPressure, MemorySnapshot } from "@/lib/memory/types";

function warning(detail: string): void { try { raiseRepair("Memory reader degraded", detail, "free_memory"); } catch { /* startup and tests may not have the database */ } }

function pressure(): MemoryPressure {
  const line = readFileSync("/proc/pressure/memory", "utf8").split("\n").find((entry) => entry.startsWith("some ")) ?? "";
  const avg10 = Number(line.match(/avg10=([0-9.]+)/)?.[1] ?? 0);
  return avg10 > 50 ? "critical" : avg10 > 10 ? "warn" : "normal";
}

export function createLinuxMemoryReader(): MemoryReader {
  let previous: MemorySnapshot = { totalBytes: os.totalmem(), availablePercent: 0, pressure: "normal", freeBytes: 0 };
  return {
    read: () => {
      try {
        const values = Object.fromEntries(readFileSync("/proc/meminfo", "utf8").split("\n").flatMap((line) => { const match = line.match(/^([^:]+):\s+(\d+)/); return match ? [[match[1]!.replaceAll(" ", ""), Number(match[2]) * 1024]] : []; }));
        const totalBytes = Number(values.MemTotal ?? os.totalmem()); const freeBytes = Number(values.MemAvailable ?? 0);
        previous = { totalBytes, freeBytes, availablePercent: totalBytes ? freeBytes / totalBytes * 100 : 0, pressure: pressure() };
      } catch (error) { warning(`The Linux memory ledger probe failed: ${(error as Error).message}`); }
      return { ...previous };
    },
    processFootprint: (pid) => {
      try { const line = readFileSync(`/proc/${pid}/status`, "utf8").split("\n").find((entry) => entry.startsWith("VmRSS:")); return line ? Number(line.replace(/\D/g, "")) * 1024 : null; } catch { return null; }
    },
  };
}
