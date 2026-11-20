import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { H3_PINNED_FILES } from "@/video/h3Pin";
import { h3PinStatus } from "@/video/h3Pin";
import { videoModelPaths } from "@/video/videoGen";
import { ENGINE_BINARIES } from "@/lib/engineCatalog";
import { STACK_VIDEO_H3_MODEL } from "@/lib/modelCatalog";

const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), "h3-pin-")); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); delete process.env.MAIPAI_H3_VIDEO_HOME; });

test("published H3 pin files have full provenance and unique local paths", () => {
  expect(H3_PINNED_FILES).toHaveLength(39);
  expect(new Set(H3_PINNED_FILES.map((file) => file.local)).size).toBe(H3_PINNED_FILES.length);
  for (const file of H3_PINNED_FILES) {
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(file.bytes).toBeGreaterThan(0);
    expect(file.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(file.local).not.toContain("4-bit-pruned-stream2");
    expect(file.local.toLowerCase()).not.toContain("lora");
  }
  expect(STACK_VIDEO_H3_MODEL.download?.files).toHaveLength(H3_PINNED_FILES.length);
  expect(ENGINE_BINARIES.find((pin) => pin.name === "minimax-h3-video-gen")).toMatchObject({ tag: "55bb7dd", archive: { sha256: "5ed91b6815555ea4638aa4648b4918308e6182c73a650d09c694a1e3d1ae1356" } });
});

test("recognizes complete and changed environment-only installs without blocking runtime paths", async () => {
  const home = root();
  const bytes = new TextEncoder().encode("tiny h3 file");
  const files = [{ repo: "test/repo", revision: "a".repeat(40), path: "x", local: "weights/x", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }];
  const target = join(home, "models/minimax_h3/weights/x");
  mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, bytes);
  mkdirSync(join(home, "node/scripts"), { recursive: true }); writeFileSync(join(home, "node/scripts/generate_staged.py"), "");
  mkdirSync(join(home, ".venv/bin"), { recursive: true }); writeFileSync(join(home, ".venv/bin/python"), "");
  mkdirSync(join(home, "models/minimax_h3/upstream/FL2VA"), { recursive: true }); mkdirSync(join(home, "models/minimax_h3/qwen/8-bit"), { recursive: true }); mkdirSync(join(home, "models/minimax_h3/transformers/8-bit"), { recursive: true });
  process.env.MAIPAI_H3_VIDEO_HOME = home;
  expect((await h3PinStatus(home, files)).state).toBe("adopted_existing");
  expect(videoModelPaths("h3")?.h3Home).toBe(home);
  writeFileSync(target, "changed");
  expect((await h3PinStatus(home, files)).state).toBe("existing_unverified");
  expect(videoModelPaths("h3")?.h3Home).toBe(home);
});

test("uses source-root or legacy node script and follows the documented language", async () => {
  const home = root();
  const make = () => { mkdirSync(join(home, ".venv/bin"), { recursive: true }); writeFileSync(join(home, ".venv/bin/python"), ""); mkdirSync(join(home, "models/minimax_h3/upstream/FL2VA"), { recursive: true }); mkdirSync(join(home, "models/minimax_h3/qwen/8-bit"), { recursive: true }); mkdirSync(join(home, "models/minimax_h3/transformers/8-bit"), { recursive: true }); };
  make(); process.env.MAIPAI_H3_VIDEO_HOME = home;
  mkdirSync(join(home, "scripts"), { recursive: true }); writeFileSync(join(home, "scripts/generate_staged.py"), "");
  expect(videoModelPaths("h3")?.h3Script).toBe(join(home, "scripts/generate_staged.py"));
  mkdirSync(join(home, "node/scripts"), { recursive: true }); writeFileSync(join(home, "node/scripts/generate_staged.py"), "");
  expect(videoModelPaths("h3")?.h3Script).toBe(join(home, "node/scripts/generate_staged.py"));
  expect(await Bun.file(new URL("../../docs/dev/h3-pin.md", import.meta.url)).text()).toContain("two files on existing installs have no published source; they keep working there and are not offered elsewhere.");
});

test("the parts list's cheap look never reads a file's bytes: sizes only, so a big folder is not hashed to list parts", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { h3PinStatus } = await import("@/video/h3Pin");
  const home = mkdtempSync(join(tmpdir(), "h3pin-"));
  try {
    mkdirSync(join(home, "models/minimax_h3/qwen/8-bit"), { recursive: true });
    writeFileSync(join(home, "models/minimax_h3/qwen/8-bit/a.json"), "abc");
    const table = [{ repo: "r", revision: "0".repeat(40), path: "a.json", local: "qwen/8-bit/a.json", bytes: 3, sha256: createHash("sha256").update("abc").digest("hex") }];
    const cheap = await h3PinStatus(home, table as never, { hashes: false });
    expect(cheap.state).toBe("existing_unverified");   // not hashed yet: honestly "not verified"
    expect(cheap.matched).toEqual([]);
    const full = await h3PinStatus(home, table as never);
    expect(full.matched).toEqual(["qwen/8-bit/a.json"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
