import os from "node:os";
import { raise } from "@/lib/health";
import type { MemoryReader, MemorySnapshot } from "@/lib/memory/types";

export function createWindowsMemoryReader(): MemoryReader {
  let warned = false;
  const probeError = "GlobalMemoryStatusEx and GetProcessMemoryInfo need a Windows FFI implementation.";
  const snapshot: MemorySnapshot = { totalBytes: os.totalmem(), availablePercent: 0, pressure: "normal", freeBytes: os.totalmem(), degraded: true, probeError };
  return {
    read: () => {
      if (!warned) { warned = true; try { raise({ code: "memory-reader-degraded", severity: "warning", title: "Windows memory reader is not available", text: "GlobalMemoryStatusEx and GetProcessMemoryInfo need a Windows FFI implementation.", cause: "GlobalMemoryStatusEx and GetProcessMemoryInfo need a Windows FFI implementation." }); } catch { /* startup and tests may not have the database */ } }
      return { ...snapshot };
    },
    processFootprint: () => null,
  };
}
