import type { MemoryReader } from "@/lib/memory/types";
import { createDarwinMemoryReader } from "@/lib/memory/darwin";
import { createLinuxMemoryReader } from "@/lib/memory/linux";
import { createWindowsMemoryReader } from "@/lib/memory/windows";

let override: MemoryReader | null = null;
let reader: MemoryReader | null = null;

export function getMemoryReader(): MemoryReader {
  if (override) return override;
  if (reader) return reader;
  reader = process.platform === "darwin" ? createDarwinMemoryReader() : process.platform === "win32" ? createWindowsMemoryReader() : createLinuxMemoryReader();
  return reader;
}

export function __setMemoryReaderForTests(memoryReader: MemoryReader | null): void { override = memoryReader; }
export type { MemoryReader, MemoryPressure, MemorySnapshot } from "@/lib/memory/types";
