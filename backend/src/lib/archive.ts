import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";

async function run(cmd: string[]): Promise<void> {
  const proc = spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`${cmd.join(" ")} exited ${code}: ${stderr.trim()}`);
  }
}

export async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  const stagingDir = mkdtempSync(join(destDir, ".extract-"));
  try {
    await run(["tar", "-xf", archivePath, "-C", stagingDir]);
    const entries = readdirSync(stagingDir);
    const sourceDir = entries.length === 1 && statSync(join(stagingDir, entries[0]!)).isDirectory()
      ? join(stagingDir, entries[0]!)
      : stagingDir;
    for (const entry of readdirSync(sourceDir)) renameSync(join(sourceDir, entry), join(destDir, entry));
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}
