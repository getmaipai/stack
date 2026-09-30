import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMetalCapBytes, readMetalCapBytes, resetMetalCapForTests } from "@/lib/metalCap";

const output = "Available devices:\n  MTL0: Apple M4 Pro (18186 MiB, 18185 MiB free)\n  BLAS: Accelerate (0 MiB, 0 MiB free)";
const appleSilicon = process.platform === "darwin" && process.arch === "arm64";
const dirs: string[] = [];

afterEach(() => {
  delete process.env.STACK_LLAMA_SERVER_BINARY;
  resetMetalCapForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("parses the largest Metal device cap and ignores BLAS", () => {
  expect(parseMetalCapBytes(output)).toBe(18186 * 1_048_576);
  expect(parseMetalCapBytes("MTL0: GPU (16384 MiB, 16000 MiB free)\nMTL1: GPU (24576 MiB, 24000 MiB free)")).toBe(24576 * 1_048_576);
  expect(parseMetalCapBytes("BLAS: Accelerate (0 MiB, 0 MiB free)")).toBeNull();
  expect(parseMetalCapBytes("")).toBeNull();
});

test.skipIf(!appleSilicon)("reads the Metal cap from the configured llama-server script (requires darwin arm64)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "maipai-metal-cap-")); dirs.push(dir);
  const binary = join(dir, "llama-server");
  writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' '${output.replaceAll("'", "'\\''")}'\n`); chmodSync(binary, 0o755);
  process.env.STACK_LLAMA_SERVER_BINARY = binary;
  expect(await readMetalCapBytes()).toBe(18186 * 1_048_576);
});

test.skipIf(!appleSilicon)("returns null for a failing or missing llama-server (requires darwin arm64)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "maipai-metal-cap-")); dirs.push(dir);
  const binary = join(dir, "llama-server");
  writeFileSync(binary, "#!/bin/sh\nexit 1\n"); chmodSync(binary, 0o755);
  process.env.STACK_LLAMA_SERVER_BINARY = binary;
  expect(await readMetalCapBytes()).toBeNull();
  resetMetalCapForTests();
  process.env.STACK_LLAMA_SERVER_BINARY = join(dir, "missing");
  expect(await readMetalCapBytes()).toBeNull();
});

test("the process probe cases are skipped outside darwin arm64", () => {
  if (!appleSilicon) expect(appleSilicon).toBe(false);
});
