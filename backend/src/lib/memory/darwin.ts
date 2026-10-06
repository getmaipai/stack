import { dlopen, FFIType, ptr } from "bun:ffi";
import os from "node:os";
import { raise } from "@/lib/health";
import type { MemoryReader, MemoryPressure, MemorySnapshot } from "@/lib/memory/types";

const PAGE_SIZE_FALLBACK = 16_384;
const HOST_VM_INFO64 = 4;
const HOST_VM_INFO64_COUNT = 38;
const RUSAGE_INFO_V4 = 4;
// Byte offsets in `struct rusage_info_v4` (<sys/resource.h>): after the
// 16-byte uuid come user time, system time, idle wakeups, interrupt
// wakeups, pageins, wired size, then these two.
const RUSAGE_RESIDENT_SIZE_OFFSET = 64;
const RUSAGE_PHYS_FOOTPRINT_OFFSET = 72;

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

// Word offsets in `vm_statistics64_data_t` (<mach/vm_statistics.h>):
// 32-bit page counts, with 64-bit event counters taking two words each.
const VM_FREE = 0;
const VM_INACTIVE = 2;
const VM_PURGEABLE = 22;
const VM_SPECULATIVE = 23;
const VM_EXTERNAL = 34;

/** The one definition of available memory on macOS: what the kernel
 * hands to a new process without compressing or swapping memory anyone
 * is using. Two exact counts, each of pages that do not overlap:
 *
 * - free pages plus the file-backed cache (`external_page_count`, every
 *   clean file page on the active, inactive or speculative queue, which
 *   the kernel drops and can read back) plus purgeable pages (volatile
 *   anonymous memory it discards). This is Activity Monitor's "Cached
 *   Files" plus free, the figure XNU's own available-pages count is
 *   built on, and the macOS twin of Linux's `MemAvailable`.
 * - free pages plus the inactive and speculative queues: the next pages
 *   the kernel reclaims under pressure, file-backed or not.
 *
 * Available is the larger of the two. Adding them would count twice the
 * file pages on the inactive and speculative queues (speculative pages
 * are always file-backed: active + inactive + speculative equals
 * internal + external page for page). Active anonymous memory and the
 * compressor are never counted, so admission never plans on compressing
 * a working set; the kernel's pressure level guards the rest.
 * Measured 2026-10-06 on the p16 laptop: before this, the reader added
 * free plus inactive plus word 13 (the high half of the faults counter,
 * meant to be purgeable) and reported 8.2 GiB while about 16 GB of file
 * cache was reclaimable. */
export function availableBytesFromVmStatistics(stats: ArrayLike<number>, pageSize: number): number {
  const free = stats[VM_FREE]!;
  const fileCache = stats[VM_EXTERNAL]! + stats[VM_PURGEABLE]!;
  const reclaimQueues = stats[VM_INACTIVE]! + stats[VM_SPECULATIVE]!;
  return (free + Math.max(fileCache, reclaimQueues)) * pageSize;
}

function hostAvailableBytes(): number {
  const native = loadSymbols();
  const stats = new Uint32Array(HOST_VM_INFO64_COUNT); const count = new Uint32Array([HOST_VM_INFO64_COUNT]);
  const host = native.mach_host_self();
  if (native.host_statistics64(host, HOST_VM_INFO64, ptr(stats), ptr(count)) !== 0) throw new Error("host_statistics64 failed");
  const pageSize = new Uint32Array([PAGE_SIZE_FALLBACK]);
  if (native.host_page_size(host, ptr(pageSize)) !== 0) throw new Error("host_page_size failed");
  return availableBytesFromVmStatistics(stats, pageSize[0] || PAGE_SIZE_FALLBACK);
}

/** The one definition of a process's memory on macOS, from the two
 * figures one `proc_pid_rusage` call returns: the larger of the resident
 * size and the physical footprint. The resident size counts the model
 * weights an engine memory-maps (llama-server maps the GGUF; those clean
 * file-backed pages are not in the footprint); the footprint counts what
 * the resident size cannot see (pages the kernel compressed, graphics
 * memory owned but not mapped). Measured on the live chat engine
 * (Qwen3-8B Q4_K_M, context 40,960, 2026-10-06): footprint 3.50 GB,
 * resident 8.38 GB, `vmmap` mapped file 4.7 GiB resident. */
export function processMemoryFromRusage(figures: { residentBytes: number; footprintBytes: number }): number | null {
  const best = Math.max(figures.residentBytes, figures.footprintBytes);
  return Number.isFinite(best) && best > 0 ? best : null;
}

/** The documented fallback when `proc_pid_rusage` cannot be read:
 * `ps -o rss=`, the same resident size, at the cost of a process spawn. */
function psResidentBytes(pid: number): number | null {
  try {
    const out = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)]).stdout.toString().trim();
    const kib = Number(out);
    return out && Number.isFinite(kib) && kib > 0 ? kib * 1024 : null;
  } catch {
    return null;
  }
}

function processMemoryBytes(pid: number): number | null {
  try {
    const native = loadSymbols(); const usage = new Uint8Array(1024);
    if (native.proc_pid_rusage(pid, RUSAGE_INFO_V4, ptr(usage)) === 0) {
      const view = new DataView(usage.buffer);
      return processMemoryFromRusage({ residentBytes: Number(view.getBigUint64(RUSAGE_RESIDENT_SIZE_OFFSET, true)), footprintBytes: Number(view.getBigUint64(RUSAGE_PHYS_FOOTPRINT_OFFSET, true)) });
    }
  } catch (error) {
    warning(`The macOS process memory probe failed: ${(error as Error).message}`);
  }
  return psResidentBytes(pid);
}

export function createDarwinMemoryReader(): MemoryReader {
  let previous: MemorySnapshot | null = null;
  return {
    read: () => {
      try {
        const totalBytes = sysctlNumber("hw.memsize");
        const availablePercent = Math.max(0, Math.min(100, sysctlNumber("kern.memorystatus_level")));
        const pressure = pressureFor(sysctlNumber("kern.memorystatus_vm_pressure_level"));
        const freeBytes = hostAvailableBytes();
        previous = { totalBytes, availablePercent, pressure, freeBytes, degraded: false };
      } catch (error) {
        const detail = `The macOS memory ledger probe failed: ${(error as Error).message}`;
        warning(detail);
        if (previous) return { ...previous, degraded: true, probeError: detail };
        return { totalBytes: os.totalmem(), availablePercent: 0, pressure: "normal", freeBytes: os.totalmem(), degraded: true, probeError: detail };
      }
      if (previous) return { ...previous };
      return { totalBytes: os.totalmem(), availablePercent: 0, pressure: "normal", freeBytes: os.totalmem(), degraded: true };
    },
    processMemoryBytes,
  };
}
