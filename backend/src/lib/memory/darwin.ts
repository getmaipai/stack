import { dlopen, FFIType, ptr } from "bun:ffi";
import os from "node:os";
import { raise } from "@/lib/health";
import type { MemoryReader, MemoryPressure, MemorySnapshot } from "@/lib/memory/types";

const PAGE_SIZE_FALLBACK = 16_384;
const HOST_VM_INFO64 = 4;
const HOST_VM_INFO64_COUNT = 38;
const RUSAGE_INFO_V4 = 4;

type DarwinSymbols = {
  sysctlbyname: (name: string | Uint8Array, old: unknown, length: unknown, newer: null, newLength: bigint) => number;
  mach_host_self: () => number;
  host_page_size: (host: number, size: unknown) => number;
  host_statistics64: (host: number, flavor: number, stats: unknown, count: unknown) => number;
  proc_pid_rusage: (pid: number, flavor: number, usage: unknown) => number;
};

let symbols: DarwinSymbols | null = null;
let warned = false;

function warning(detail: string): void {
  if (warned) return;
  warned = true;
  try { raise({ code: "memory-reader-degraded", severity: "warning", title: "Memory reader degraded", text: detail, cause: detail }); } catch { /* startup and tests may not have the database */ }
}

function loadSymbols(): DarwinSymbols {
  if (symbols) return symbols;
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    sysctlbyname: { args: [FFIType.cstring, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    mach_host_self: { args: [], returns: FFIType.i32 },
    host_page_size: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    host_statistics64: { args: [FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  });
  symbols = library.symbols as unknown as DarwinSymbols;
  return symbols;
}

function sysctlNumber(name: string): number {
  const native = loadSymbols();
  const out = new BigUint64Array(1); const length = new BigUint64Array([8n]);
  if (native.sysctlbyname(Buffer.from(`${name}\0`), ptr(out), ptr(length), null, 0n) !== 0) throw new Error(`${name} failed`);
  return Number(out[0]);
}

function pressureFor(level: number): MemoryPressure {
  return level >= 4 ? "critical" : level >= 2 ? "warn" : "normal";
}

function hostFreeBytes(): number {
  const native = loadSymbols();
  const stats = new Uint32Array(HOST_VM_INFO64_COUNT); const count = new Uint32Array([HOST_VM_INFO64_COUNT]);
  const host = native.mach_host_self();
  if (native.host_statistics64(host, HOST_VM_INFO64, ptr(stats), ptr(count)) !== 0) throw new Error("host_statistics64 failed");
  const pageSize = new Uint32Array([PAGE_SIZE_FALLBACK]);
  if (native.host_page_size(host, ptr(pageSize)) !== 0) throw new Error("host_page_size failed");
  return (stats[0]! + stats[2]! + stats[13]!) * (pageSize[0] || PAGE_SIZE_FALLBACK);
}

function footprint(pid: number): number | null {
  try {
    const native = loadSymbols(); const usage = new Uint8Array(1024);
    if (native.proc_pid_rusage(pid, RUSAGE_INFO_V4, ptr(usage)) !== 0) return null;
    return Number(new DataView(usage.buffer).getBigUint64(72, true));
  } catch (error) {
    warning(`The macOS process footprint probe failed: ${(error as Error).message}`);
    return null;
  }
}

export function createDarwinMemoryReader(): MemoryReader {
  let previous: MemorySnapshot = { totalBytes: os.totalmem(), availablePercent: 0, pressure: "normal", freeBytes: 0 };
  return {
    read: () => {
      try {
        const totalBytes = sysctlNumber("hw.memsize");
        const availablePercent = Math.max(0, Math.min(100, sysctlNumber("kern.memorystatus_level")));
        const pressure = pressureFor(sysctlNumber("kern.memorystatus_vm_pressure_level"));
        const freeBytes = hostFreeBytes();
        previous = { totalBytes, availablePercent, pressure, freeBytes };
      } catch (error) {
        warning(`The macOS memory ledger probe failed: ${(error as Error).message}`);
      }
      return { ...previous };
    },
    processFootprint: footprint,
  };
}
