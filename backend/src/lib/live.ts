import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getChatEngineStatus, getChatBackend, measureProcessMemoryBytes } from "@/lib/supervisor";
import { listClients } from "@/lib/clients";
import { emit } from "@/lib/events";
import { dataDir } from "@/lib/paths";
import { stackSettingValues } from "@/settings/stackKeys";

export interface LiveGpu {
  name: string;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  utilization: number | null;
}

export interface LiveProcess {
  engine: string;
  build: string;
  model: string | null;
  port: number | null;
  memoryFootprintBytes: number | null;
  cpuPercent: number | null;
  pid: number;
  startedAt: string | null;
}

export interface LiveDrive {
  name: string;
  mount: string;
  usedBytes: number;
  totalBytes: number;
  mounted: boolean;
}

export interface LiveClient {
  name: string;
  roles: string[];
  requestCount: number;
  lastRequestAt: string;
}

export interface LiveSample {
  processes: LiveProcess[];
  gpus: LiveGpu[];
  cpu: { percent: number | null };
  drives: LiveDrive[];
  clients: LiveClient[];
  at: string;
}

type ExecFileResult = { stdout: string; stderr: string };

export interface LiveReaders {
  ps: () => Promise<ExecFileResult>;
  nvidiaSmi: () => Promise<ExecFileResult>;
  systemProfiler: () => Promise<ExecFileResult>;
  ioreg: () => Promise<ExecFileResult>;
  df: () => Promise<ExecFileResult>;
  diskutil: (mount: string) => Promise<ExecFileResult>;
}

const execFileAsync = promisify(execFile);
const defaultReaders: LiveReaders = {
  ps: () => execFileAsync("ps", ["-eo", "pid,%cpu,lstart,command"], { timeout: 2_000 }),
  nvidiaSmi: () => execFileAsync("nvidia-smi", ["--query-gpu=name,memory.used,memory.total,utilization.gpu", "--format=csv,noheader,nounits"], { timeout: 2_000 }),
  systemProfiler: () => execFileAsync("system_profiler", ["SPDisplaysDataType", "-json"], { timeout: 5_000 }),
  ioreg: () => execFileAsync("ioreg", ["-r", "-d", "1", "-c", "IOAccelerator"], { timeout: 5_000 }),
  df: () => execFileAsync("df", ["-k", dataDir], { timeout: 2_000 }),
  diskutil: (mount: string) => execFileAsync("diskutil", ["info", "-plist", mount], { timeout: 5_000 }),
};

let readers: LiveReaders = defaultReaders;

export function __setLiveReadersForTests(next: Partial<LiveReaders>): void {
  readers = { ...defaultReaders, ...next };
}

let lastSample: LiveSample | null = null;
let samplerHandle: ReturnType<typeof setInterval> | null = null;

export function __resetLiveForTests(): void {
  lastSample = null;
  if (samplerHandle) {
    clearInterval(samplerHandle);
    samplerHandle = null;
  }
}

export function __setLiveClockForTests(_clock: unknown): void {}

function parsePsCpu(output: string, pid: number): number | null {
  const lines = output.trim().split("\n");
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === String(pid)) {
      const cpu = Number(fields[1]);
      return Number.isFinite(cpu) ? cpu : null;
    }
  }
  return null;
}

function parsePsStart(output: string, pid: number): string | null {
  const lines = output.trim().split("\n");
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === String(pid)) {
      const startedAt = new Date(fields.slice(2, 7).join(" "));
      return Number.isNaN(startedAt.getTime()) ? null : startedAt.toISOString();
    }
  }
  return null;
}

function parseNvidiaSmi(output: string): LiveGpu[] {
  const lines = output.trim().split("\n").filter((line) => line.trim());
  return lines.map((line) => {
    const [name, memoryUsed, memoryTotal, utilization] = line.split(",").map((field) => field.trim());
    const used = memoryUsed !== undefined ? Number(memoryUsed) : NaN;
    const total = memoryTotal !== undefined ? Number(memoryTotal) : NaN;
    const util = utilization !== undefined ? Number(utilization) : NaN;
    return {
      name: name || "",
      memoryUsedBytes: Number.isFinite(used) ? used * 1024 : null,
      memoryTotalBytes: Number.isFinite(total) ? total * 1024 : null,
      utilization: Number.isFinite(util) ? util : null,
    };
  });
}

function parseMacGpu(systemProfilerOutput: string, ioregOutput: string): LiveGpu {
  let name: string | null = null;
  let utilization: number | null = null;
  try {
    const data = JSON.parse(systemProfilerOutput) as Record<string, Record<string, { sppci_model?: string }>>;
    const display = data["SPDisplaysDataType"];
    if (display) {
      const entries = Object.values(display);
      const first = entries[0];
      if (first && typeof first.sppci_model === "string" && first.sppci_model.trim()) {
        name = first.sppci_model.trim();
      }
    }
  } catch {}
  const match = ioregOutput.match(/"Device Utilization %"\s*=\s*(\d+(?:\.\d+)?)/);
  if (match) {
    const value = Number(match[1]);
    utilization = Number.isFinite(value) ? value : null;
  }
  return { name: name ?? "", memoryUsedBytes: null, memoryTotalBytes: null, utilization };
}

function driveName(mount: string): string {
  const segments = mount.replace(/^\//, "").split("/");
  const last = segments[segments.length - 1] ?? "";
  return last || mount;
}

function isUserVisibleVolume(mount: string): boolean {
  if (!mount) return false;
  if (mount === "/") return true;
  if (mount.startsWith("/dev/") || mount.startsWith("/proc/") || mount.startsWith("/sys/") || mount.startsWith("/run/")) return false;
  if (mount.startsWith("/System/Volumes/VM")) return false;
  if (mount.startsWith("/Volumes/") || mount.startsWith("/System/Volumes/")) return true;
  return false;
}

function diskutilVolumeName(output: string): string | null {
  const match = output.match(/<key>VolumeName<\/key>\s*<string>([^<]*)<\/string>/);
  return match?.[1] ?? null;
}

function macFinderName(rawMount: string): Promise<{ name: string; mount: string }> {
  if (rawMount !== "/System/Volumes/Data") {
    return Promise.resolve({ name: driveName(rawMount), mount: rawMount });
  }
  return readers.diskutil("/System/Volumes/Data").then(
    (result) => {
      const volumeName = diskutilVolumeName(result.stdout);
      return {
        name: volumeName ? volumeName.replace(/ - Data$/, "") : "Macintosh HD",
        mount: "/",
      };
    },
    () => ({ name: "Macintosh HD", mount: "/" }),
  );
}

function parseDf(output: string): Promise<LiveDrive[]> {
  const lines = output.trim().split("\n");
  if (lines.length < 2) return Promise.resolve([]);
  const header = (lines[0] ?? "").split(/\s+/);
  const usedIdx = header.findIndex((h) => h === "Used");
  const totalIdx = header.findIndex((h) => h === "Avail" || h === "1024-blocks");
  const entries: { used: number; total: number; rawMount: string }[] = [];
  for (const line of lines.slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length === 0) continue;
    const mount = fields[fields.length - 1] ?? "";
    if (!isUserVisibleVolume(mount)) continue;
    const used = usedIdx >= 0 && fields[usedIdx] !== undefined ? Number(fields[usedIdx]) : 0;
    const total = totalIdx >= 0 && fields[totalIdx] !== undefined ? Number(fields[totalIdx]) : 0;
    entries.push({ used, total, rawMount: mount });
  }
  return Promise.all(entries.map((entry) => macFinderName(entry.rawMount))).then((named) =>
    named.map((entry, index) => ({
      name: entry.name,
      mount: entry.mount,
      usedBytes: entries[index]!.used * 1024,
      totalBytes: entries[index]!.total * 1024,
      mounted: true,
    })),
  );
}

function driveFilter(): "all" | string[] {
  const raw = stackSettingValues().storageDrives;
  if (typeof raw === "string" && raw === "all") return "all";
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) return raw;
  return "all";
}

function filterDrives(drives: LiveDrive[]): LiveDrive[] {
  const filter = driveFilter();
  const mountedMounts = new Set(drives.map((d) => d.mount));
  const chosen = filter === "all"
    ? drives
    : drives.filter((d) => filter.includes(d.mount));
  const chosenSet = new Set(chosen.map((d) => d.mount));
  const unmounted = filter === "all" ? [] : filter.filter((m) => !mountedMounts.has(m)).map((m) => ({ name: driveName(m), mount: m, usedBytes: 0, totalBytes: 0, mounted: false }));
  return [...chosen, ...unmounted.filter((u) => !chosenSet.has(u.mount))];
}

export async function collectSample(): Promise<LiveSample> {
  const status = getChatEngineStatus();
  const backend = await getChatBackend().catch(() => null);
  const pid = backend?.pid ?? null;

  const psResult = await readers.ps().catch(() => null);
  const psOutput = psResult ? psResult.stdout : "";
  const cpuPercent = pid !== null ? parsePsCpu(psOutput, pid) : null;
  const startedAt = pid !== null ? parsePsStart(psOutput, pid) : null;
  const memoryFootprint = pid !== null ? await measureProcessMemoryBytes(pid) : null;

  const port = backend?.port ?? null;

  const processes: LiveProcess[] = [];
  if (status.state === "ready" || status.state === "busy" || status.state === "loading") {
    processes.push({
      engine: "chat",
      build: status.identity?.build ?? "unknown",
      model: status.identity?.model ?? null,
      port,
      memoryFootprintBytes: memoryFootprint,
      cpuPercent,
      pid: pid ?? 0,
      startedAt,
    });
  }

  let gpus: LiveGpu[];
  if (process.platform === "darwin") {
    const [profilerResult, ioregResult] = await Promise.all([
      readers.systemProfiler().catch(() => null),
      readers.ioreg().catch(() => null),
    ]);
    const profilerOutput = profilerResult ? profilerResult.stdout : "";
    const ioregOutput = ioregResult ? ioregResult.stdout : "";
    gpus = [parseMacGpu(profilerOutput, ioregOutput)];
  } else {
    const cudaResult = await readers.nvidiaSmi().catch(() => null);
    const cudaOutput = cudaResult ? cudaResult.stdout : "";
    gpus = cudaOutput ? parseNvidiaSmi(cudaOutput) : [];
  }

  const dfResult = await readers.df().catch(() => null);
  const dfOutput = dfResult ? dfResult.stdout : "";
  const drives = filterDrives(await parseDf(dfOutput));

  const now = new Date();
  const fiveMinutesAgoMs = now.getTime() - 5 * 60 * 1000;
  const clients = listClients()
    .filter((client) => client.lastSeenAt !== null && new Date(client.lastSeenAt).getTime() >= fiveMinutesAgoMs)
    .map((client) => ({
      name: client.name,
      roles: client.allowedRoles,
      requestCount: client.requests,
      lastRequestAt: client.lastSeenAt as string,
    }));

  return {
    processes,
    gpus,
    cpu: { percent: cpuPercent },
    drives,
    clients,
    at: now.toISOString(),
  };
}

export function startLiveSampler(): void {
  if (samplerHandle) return;
  void collectSample().then((sample) => {
    lastSample = sample;
    emit({ id: "live", data: { ...sample } });
  });
  samplerHandle = setInterval(() => {
    void collectSample().then((sample) => {
      lastSample = sample;
      emit({ id: "live", data: { ...sample } });
    });
  }, 5000);
}

export function stopLiveSampler(): void {
  if (samplerHandle) {
    clearInterval(samplerHandle);
    samplerHandle = null;
  }
}

export function getLastLiveSample(): LiveSample | null {
  return lastSample;
}
