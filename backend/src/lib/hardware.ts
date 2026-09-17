// Real hardware detection for MaiPai Stack's model sizing and board.
// It reports the machine facts that profile and engine selection consume.
import { execFile } from "node:child_process";
import { statfsSync } from "node:fs";
import os from "node:os";
import { promisify } from "node:util";
import { dataDir } from "@/lib/paths";

const execFileAsync = promisify(execFile);

export interface CudaDevice {
  index: number;
  name: string;
  vramBytes: number;
  usedVramBytes?: number;
  utilizationPct?: number;
}

export interface HardwareInfo {
  platform: NodeJS.Platform;
  arch: string;
  totalRamGb: number;
  cpuCount: number;
  isAppleSilicon: boolean;
  unifiedMemoryGb: number;
  cudaDevices: CudaDevice[];
  freeDiskBytes: number;
  osVersion: string;
}

export async function detectCudaDevices(): Promise<CudaDevice[]> {
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      ["--query-gpu=index,name,memory.total,memory.used,utilization.gpu", "--format=csv,noheader,nounits"],
      { timeout: 8_000 },
    );
    return stdout.trim().split("\n").flatMap((line): CudaDevice[] => {
      const parts = line.split(",").map((part) => part.trim());
      if (parts.length < 3) return [];
      const index = parseInt(parts[0] ?? "", 10);
      const name = parts[1] ?? "";
      const vramMiB = parseInt(parts[2] ?? "", 10);
      if (Number.isNaN(index) || Number.isNaN(vramMiB)) return [];
      const usedMiB = parseInt(parts[3] ?? "", 10);
      const utilPct = parseInt(parts[4] ?? "", 10);
      return [{
        index,
        name,
        vramBytes: vramMiB * 1_048_576,
        usedVramBytes: Number.isNaN(usedMiB) ? undefined : usedMiB * 1_048_576,
        utilizationPct: Number.isNaN(utilPct) ? undefined : utilPct,
      }];
    });
  } catch {
    return [];
  }
}

function detectIsAppleSilicon(): boolean {
  return process.platform === "darwin" && (os.cpus()[0]?.model ?? "").includes("Apple");
}

const DETECTION_CACHE_MS = 5_000;
let cached: { at: number; info: HardwareInfo } | null = null;

export async function detectHardware(): Promise<HardwareInfo> {
  if (cached && Date.now() - cached.at < DETECTION_CACHE_MS) return cached.info;
  const totalRamGb = Math.round(os.totalmem() / 1_073_741_824);
  const isAppleSilicon = detectIsAppleSilicon();
  const cudaDevices = isAppleSilicon ? [] : await detectCudaDevices();
  const disk = statfsSync(dataDir);
  const info: HardwareInfo = {
    platform: process.platform,
    arch: process.arch,
    totalRamGb,
    cpuCount: os.cpus().length,
    isAppleSilicon,
    unifiedMemoryGb: isAppleSilicon ? totalRamGb : 0,
    cudaDevices,
    freeDiskBytes: disk.bavail * disk.bsize,
    osVersion: os.release(),
  };
  cached = { at: Date.now(), info };
  return info;
}

export function __resetHardwareCacheForTests(): void {
  cached = null;
}

export function primaryBudgetBytes(hw: HardwareInfo): number {
  if (hw.isAppleSilicon) return hw.unifiedMemoryGb * 1_073_741_824;
  if (hw.cudaDevices.length === 0) return 0;
  return hw.cudaDevices.reduce(
    (max, device) => Math.max(max, device.vramBytes - (device.usedVramBytes ?? 0)),
    0,
  );
}
