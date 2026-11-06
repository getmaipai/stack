import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, utimesSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import { runSweeps } from "@/lib/sweeps";

const files = ["models/old.bin.part", "models/new.bin.part", "tmp/voice-clips/old.wav", "tmp/voice-clips/new.wav", "tmp/video/stale/clip"];
afterEach(() => { for (const path of ["models", "tmp/video", "tmp/voice-clips", "logs"]) rmSync(join(dataDir, path), { recursive: true, force: true }); });

test("sweeps stale downloads, voice clips and video work with byte accounting and one log line", async () => {
  for (const path of files) { const full = join(dataDir, path); mkdirSync(join(full, ".."), { recursive: true }); writeFileSync(full, "12345"); }
  const old = new Date(Date.now() - 8 * 24 * 3600_000);
  for (const path of ["models/old.bin.part", "tmp/voice-clips/old.wav"]) utimesSync(join(dataDir, path), old, old);
  const timer = await runSweeps("timer");
  expect(existsSync(join(dataDir, "tmp/video/stale/clip"))).toBe(true);
  expect(timer.per_sweep.some((entry) => entry.name === "video-tmp")).toBe(false);
  const first = await runSweeps("start");
  expect(existsSync(join(dataDir, "models/old.bin.part"))).toBe(false);
  expect(existsSync(join(dataDir, "models/new.bin.part"))).toBe(true);
  expect(existsSync(join(dataDir, "tmp/voice-clips/old.wav"))).toBe(false);
  expect(existsSync(join(dataDir, "tmp/voice-clips/new.wav"))).toBe(true);
  expect(existsSync(join(dataDir, "tmp/video/stale/clip"))).toBe(false);
  expect(timer.removed_files + first.removed_files).toBeGreaterThanOrEqual(2);
  expect(timer.freed_bytes + first.freed_bytes).toBeGreaterThanOrEqual(10);
  const log = readFileSync(join(dataDir, "logs", "stack.log"), "utf8");
  expect(log.match(/"event":"sweep\.done"/g)?.length).toBeGreaterThanOrEqual(2);
  await runSweeps("start");
  expect(readFileSync(join(dataDir, "logs", "stack.log"), "utf8").match(/"event":"sweep\.done"/g)?.length).toBeGreaterThanOrEqual(2);
});
