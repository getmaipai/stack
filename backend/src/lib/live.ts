import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getChatEngineStatus, getChatBackend, measureProcessMemoryBytes } from "@/lib/supervisor";
import { listClients } from "@/lib/clients";
import { emit } from "@/lib/events";
import { dataDir } from "@/lib/paths";

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
  usedBytes: number;
  totalBytes: number;
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
}

const execFileAsync = promisify(execFile);
const defaultReaders: LiveReaders = {
  ps: () => execFileAsync("ps", ["-eo", "pid,%cpu,lstart,command"], { timeout: 2_000 }),
  nvidiaSmi: () => execFileAsync("nvidia-smi", ["--query-gpu=name,memory.used,memory.total,utilization.gpu", "--format=csv,noheader,nounits"], { timeout: 2_000 }),
  systemProfiler: () => execFileAsync("system_profiler", ["SPDisplaysDataType", "-json"], { timeout: 5_000 }),
  ioreg: () => execFileAsync("ioreg", ["-r", "-d", "1", "-c", "IOAccelerator"], { timeout: 5_000 }),
  df: () => execFileAsync("df", ["-k", dataDir], { timeout: 2_000 }),
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

function parseDf(output: string): LiveDrive[] {
  const lines = output.trim().split("\n");
  if (lines.length < 2) return [];
  const header = (lines[0] ?? "").split(/\s+/);
  const dataLine = lines[1] ?? "";
  const fields = dataLine.split(/\s+/);
  const usedIdx = header.findIndex((h) => h === "Used");
  const totalIdx = header.findIndex((h) => h === "Avail" || h === "1024-blocks");
  const used = usedIdx >= 0 && fields[usedIdx] !== undefined ? Number(fields[usedIdx]) : 0;
  const total = totalIdx >= 0 && fields[totalIdx] !== undefined ? Number(fields[totalIdx]) : 0;
  const name = (fields[0] ?? "").replace(/^\//, "");
  if (!name || name === "Filesystem" || name.startsWith("/dev/")) return [];
  return [{ name, usedBytes: used * 1024, totalBytes: total * 1024 }];
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
  const drives = parseDf(dfOutput);

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
