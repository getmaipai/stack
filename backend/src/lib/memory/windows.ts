import os from "node:os";
import { raiseRepair } from "@/lib/repairs";
import type { MemoryReader, MemorySnapshot } from "@/lib/memory/types";

export function createWindowsMemoryReader(): MemoryReader {
  let warned = false;
  const snapshot: MemorySnapshot = { totalBytes: os.totalmem(), availablePercent: 0, pressure: "normal", freeBytes: 0 };
  return {
    read: () => {
      if (!warned) { warned = true; try { raiseRepair("Windows memory reader is not available", "GlobalMemoryStatusEx and GetProcessMemoryInfo need a Windows FFI implementation.", "free_memory"); } catch { /* startup and tests may not have the database */ } }
      return { ...snapshot };
    },
    processFootprint: () => null,
  };
}
