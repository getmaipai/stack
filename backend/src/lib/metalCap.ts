import { existsSync } from "node:fs";
import { join } from "node:path";
import { withTimeout } from "@maipai/core/src/withTimeout";
import { selectEngineBinary } from "@/lib/engineCatalog";
import { engineDir } from "@/lib/engineInstall";
import { detectHardware } from "@/lib/hardware";

const MIB = 1_048_576;
let cachedMetalCapBytes: number | null | undefined;

export function parseMetalCapBytes(output: string): number | null {
  let largestMiB = 0;
  let foundMetalLine = false;
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*MTL\d+:\s.*\((\d+) MiB,\s*(\d+) MiB free\)\s*$/.exec(line);
    if (match) { foundMetalLine = true; largestMiB = Math.max(largestMiB, Number(match[1])); }
  }
  return foundMetalLine ? largestMiB * MIB : null;
}

export async function readMetalCapBytes(): Promise<number | null> {
  if (cachedMetalCapBytes !== undefined) return cachedMetalCapBytes;
  cachedMetalCapBytes = null;
  if (process.platform !== "darwin" || process.arch !== "arm64") return null;
  try {
    let binary = process.env.STACK_LLAMA_SERVER_BINARY;
    if (!binary) {
      const hardware = await detectHardware();
      const pin = selectEngineBinary(hardware);
      binary = pin ? join(engineDir(pin), "llama-server") : "";
    }
    if (!binary || !existsSync(binary)) return null;
    const processHandle = Bun.spawn([binary, "--list-devices"], { stdout: "pipe", stderr: "pipe" });
    const outputPromise = (async () => `${await new Response(processHandle.stdout).text()}\n${await new Response(processHandle.stderr).text()}`)();
    try {
      const [output, exitCode] = await withTimeout(Promise.all([outputPromise, processHandle.exited]), 10_000, () => new Error("llama-server --list-devices timed out."));
      cachedMetalCapBytes = exitCode === 0 ? parseMetalCapBytes(output) : null;
    } catch (error) {
      if ((error as Error).message === "llama-server --list-devices timed out.") processHandle.kill();
      cachedMetalCapBytes = null;
    }
  } catch {
    cachedMetalCapBytes = null;
  }
  return cachedMetalCapBytes;
}

export function resetMetalCapForTests(): void { cachedMetalCapBytes = undefined; }
