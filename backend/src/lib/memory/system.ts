// The system memory sampler behind the watchdog: whole-machine numbers
// the governor's model of its own workers cannot see (swap, the
// kernel's pressure level, wired and compressed memory) and the process
// table (who holds the memory). The cheap numbers come from native
// calls (no spawn); the process table is one `ps` spawn, read only
// every few samples or when memory is tight.
import os from "node:os";
import { readFileSync } from "node:fs";
import { getMemoryReader, type MemoryPressure } from "@/lib/memory";
import { pressureLevel, readSwapUsage, readVmDetail } from "@/lib/memory/darwin";

export interface SystemSample {
  at: number;
  totalBytes: number;
  /** Free plus what the kernel gives back without compressing: the one definition of available (lib/memory/darwin.ts). */
  availableBytes: number;
  freeBytes: number;
  wiredBytes: number;
  compressorBytes: number;
  swapUsedBytes: number;
  swapTotalBytes: number;
  /** The kernel's level: 1 normal, 2 warn, 4 critical. */
  pressureLevel: 1 | 2 | 4;
  pressure: MemoryPressure;
  degraded: boolean;
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  rssBytes: number;
  ageSeconds: number;
  /** The executable's name. */
  name: string;
  /** The full command line. */
  command: string;
}

export interface SystemSampler {
  sample(): SystemSample;
  processes(): ProcessRow[];
  /** The working directory of a few processes (a `lsof` spawn); empty when unreadable. */
  cwds(pids: number[]): Map<number, string>;
  /** Whether a process has an open TCP connection from a client (an engine in use). */
  hasClient(pid: number): boolean;
}

function levelFor(raw: number): 1 | 2 | 4 { return raw >= 4 ? 4 : raw >= 2 ? 2 : 1; }

/** `etime` is `[[dd-]hh:]mm:ss`. */
export function parseEtime(text: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!match) return 0;
  const [, d, h, m, s] = match;
  return Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3_600 + Number(m) * 60 + Number(s);
}

/** Parses `ps -axww -o pid=,ppid=,rss=,etime=,command=`. */
export function parseProcessTable(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const command = match[5]!;
    // An app bundle's path may hold spaces: its name is the executable after Contents/MacOS/.
    const bundled = /\.app\/Contents\/MacOS\/([^ ]+)/.exec(command)?.[1];
    const name = bundled ?? (command.split(" ")[0]!.split("/").pop() || command);
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rssBytes: Number(match[3]) * 1024, ageSeconds: parseEtime(match[4]!), name, command });
  }
  return rows;
}

function spawnText(command: string[]): string {
  try { return Bun.spawnSync(command, { stdout: "pipe", stderr: "ignore" }).stdout.toString(); } catch { return ""; }
}

function systemSampler(): SystemSampler {
  const reader = getMemoryReader();
  let lastSample: SystemSample | null = null;
  return {
    sample() {
      const now = Date.now();
      const snapshot = reader.read();
      try {
        if (process.platform === "darwin") {
          const vm = readVmDetail();
          const swap = readSwapUsage();
          const level = levelFor(pressureLevel());
          lastSample = { at: now, totalBytes: snapshot.totalBytes, availableBytes: vm.availableBytes, freeBytes: vm.freeBytes, wiredBytes: vm.wiredBytes, compressorBytes: vm.compressorBytes, swapUsedBytes: swap?.usedBytes ?? 0, swapTotalBytes: swap?.totalBytes ?? 0, pressureLevel: level, pressure: level === 4 ? "critical" : level === 2 ? "warn" : "normal", degraded: false };
          return lastSample;
        }
        if (process.platform === "linux") {
          const meminfo = readFileSync("/proc/meminfo", "utf8");
          const kib = (key: string): number => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(meminfo)?.[1] ?? 0) * 1024;
          const swapTotal = kib("SwapTotal");
          lastSample = { at: now, totalBytes: kib("MemTotal") || snapshot.totalBytes, availableBytes: kib("MemAvailable"), freeBytes: kib("MemFree"), wiredBytes: 0, compressorBytes: 0, swapUsedBytes: swapTotal - kib("SwapFree"), swapTotalBytes: swapTotal, pressureLevel: snapshot.pressure === "critical" ? 4 : snapshot.pressure === "warn" ? 2 : 1, pressure: snapshot.pressure, degraded: false };
          return lastSample;
        }
      } catch { /* fall through to the reader's own figures */ }
      lastSample = { at: now, totalBytes: snapshot.totalBytes || os.totalmem(), availableBytes: snapshot.freeBytes, freeBytes: snapshot.freeBytes, wiredBytes: 0, compressorBytes: 0, swapUsedBytes: lastSample?.swapUsedBytes ?? 0, swapTotalBytes: lastSample?.swapTotalBytes ?? 0, pressureLevel: snapshot.pressure === "critical" ? 4 : snapshot.pressure === "warn" ? 2 : 1, pressure: snapshot.pressure, degraded: true };
      return lastSample;
    },
    processes() {
      return process.platform === "win32" ? [] : parseProcessTable(spawnText(["ps", "-axww", "-o", "pid=,ppid=,rss=,etime=,command="]));
    },
    cwds(pids) {
      const out = new Map<number, string>();
      if (pids.length === 0 || process.platform === "win32") return out;
      let pid = 0;
      for (const line of spawnText(["lsof", "-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")]).split("\n")) {
        if (line.startsWith("p")) pid = Number(line.slice(1));
        else if (line.startsWith("n") && pid) out.set(pid, line.slice(1));
      }
      return out;
    },
    hasClient(pid) {
      return spawnText(["lsof", "-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:ESTABLISHED", "-Fn"]).split("\n").some((line) => line.startsWith("n"));
    },
  };
}

let override: SystemSampler | null = null;
let real: SystemSampler | null = null;
export function getSystemSampler(): SystemSampler { return override ?? (real ??= systemSampler()); }
export function __setSystemSamplerForTests(sampler: SystemSampler | null): void { override = sampler; }
