import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// @/db is a process-wide singleton opened on its first import, so this test
// probes a fresh data directory from a child process (tests/dbProbe.ts).
// Importing @/db here after setting STACK_DATA_DIR only worked while this
// file was the first importer in the run: the gate's T1 subset of
// 2026-10-16 ran comfyui.test.ts first, whose readiness check wrote a
// `readiness.latest` meta row into the shared database, and the "empty
// meta" assertion below failed on it. The child process cannot share that
// singleton.
test("opens and migrates the three-table state database", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "maipai-stack-db-"));
  try {
    const probe = Bun.spawnSync(["bun", "run", "tests/dbProbe.ts"], {
      cwd: resolve(import.meta.dir, ".."),
      env: { ...process.env, STACK_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(probe.exitCode, probe.stderr.toString()).toBe(0);
    const result = JSON.parse(probe.stdout.toString().trim()) as { tables: string[]; meta: unknown[] };
    expect(result.tables).toEqual(["health", "meta", "models"]);
    expect(result.meta).toEqual([]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
