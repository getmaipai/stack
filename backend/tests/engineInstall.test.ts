import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { engineNameTag, ENGINE_READY_MARKER, type EngineBinaryPin } from "@/lib/engineCatalog";
import { engineBinaryPath, engineDir, ensureEngine } from "@/lib/engineInstall";

const testDirs: string[] = [];
afterEach(() => { for (const dir of testDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); delete process.env.STACK_DATA_DIR; });

async function makeArchive(): Promise<{ bytes: Buffer; size: number; sha256: string }> {
  const root = mkdtempSync(join(tmpdir(), "maipai-engine-source-"));
  testDirs.push(root);
  const bundle = join(root, "llama-bundle");
  const archive = join(root, "engine.tar.gz");
  mkdirSync(bundle, { recursive: true });
  await Bun.write(join(bundle, "llama-server"), "#!/bin/sh\necho llama-server\n");
  const process = spawn(["tar", "-czf", archive, "-C", root, "llama-bundle"], { stdout: "pipe", stderr: "pipe" });
  expect(await process.exited).toBe(0);
  const bytes = Buffer.from(await readFileSync(archive));
  return { bytes, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function pin(id: string, url: string, size: number, sha256: string): EngineBinaryPin {
  const { name, tag } = engineNameTag(id);
  return { id, name, tag, platform: "darwin", arch: "arm64", requiresNvidia: false, label: id, archive: { label: "test archive", url, sha256, approxBytes: size }, verified: false };
}

test("ensureEngine verifies, extracts, marks ready, and skips a ready install", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "maipai-engine-data-"));
  testDirs.push(dataDir);
  process.env.STACK_DATA_DIR = dataDir;
  const archive = await makeArchive();
  let requests = 0;
  const server = Bun.serve({ port: 0, fetch: () => { requests += 1; return new Response(archive.bytes); } });
  try {
    const target = pin("test-engine", `${server.url}`, archive.size, archive.sha256);
    await ensureEngine(target);
    expect(existsSync(engineBinaryPath(target))).toBe(true);
    expect(existsSync(join(engineDir(target), ENGINE_READY_MARKER))).toBe(true);
    const firstRequests = requests;
    await ensureEngine(target);
    expect(requests).toBe(firstRequests);
  } finally {
    server.stop(true);
  }
});

test("a wrong checksum rejects and leaves no ready marker", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "maipai-engine-data-"));
  testDirs.push(dataDir);
  process.env.STACK_DATA_DIR = dataDir;
  const archive = await makeArchive();
  const server = Bun.serve({ port: 0, fetch: () => new Response(archive.bytes) });
  try {
    const target = pin("wrong-engine", `${server.url}`, archive.size, "0".repeat(64));
    await expect(ensureEngine(target)).rejects.toThrow(/sha256/);
    expect(existsSync(join(engineDir(target), ENGINE_READY_MARKER))).toBe(false);
  } finally {
    server.stop(true);
  }
});

test("the binary that runs is the one the current link names, and only once that build finished installing", async () => {
  const { mkdirSync, rmSync, symlinkSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { currentEngineBinary, currentEngineBinaryPath } = await import("@/lib/engineInstall");
  const { engineCurrentPath, engineTagRoot } = await import("@/lib/store/layout");
  const name = `link-engine-${Date.now()}`;
  try {
    expect(currentEngineBinaryPath(name)).toBeNull();
    mkdirSync(engineTagRoot(name, "b1"), { recursive: true });
    mkdirSync(engineTagRoot(name, "b2"), { recursive: true });
    writeFileSync(join(engineTagRoot(name, "b2"), ".engine-ready"), "now");
    expect(currentEngineBinary(name)).toEqual({ state: "none" });
    symlinkSync("b1", engineCurrentPath(name));
    expect(currentEngineBinaryPath(name)).toBeNull();
    // A link at an unready build is a refusal for the supervisor, never a fallback.
    expect(currentEngineBinary(name)).toEqual({ state: "unready", tag: "b1" });
    rmSync(engineCurrentPath(name));
    symlinkSync("b2", engineCurrentPath(name));
    expect(currentEngineBinaryPath(name)).toBe(join(engineTagRoot(name, "b2"), name));
  } finally {
    rmSync(engineTagRoot(name, "b1").replace(/\/b1$/, ""), { recursive: true, force: true });
  }
});

test("a store from before the tags were upstream build tags is renamed once and its current link follows", async () => {
  const { mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync, existsSync: exists } = await import("node:fs");
  const { join } = await import("node:path");
  const { migrateLegacyEngineTags } = await import("@/lib/engineInstall");
  const { ENGINE_BINARIES } = await import("@/lib/engineCatalog");
  const { engineCurrentPath, engineTagRoot } = await import("@/lib/store/layout");
  const { readEngineManifest, writeEngineManifest } = await import("@/lib/store/manifests");
  const pin = ENGINE_BINARIES.find((candidate) => candidate.platform === process.platform)!;
  const legacyTag = pin.id.slice(pin.name.length + 1);
  const root = engineTagRoot(pin.name, pin.tag).replace(new RegExp(`/${pin.tag}$`), "");
  try {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(engineTagRoot(pin.name, legacyTag), { recursive: true });
    writeFileSync(join(engineTagRoot(pin.name, legacyTag), ".engine-ready"), "now");
    writeEngineManifest({ kind: "engine", name: pin.name, tag: legacyTag, assetUrl: pin.archive.url, sizeBytes: 1, sha256: pin.archive.sha256, extractedAt: new Date().toISOString(), blobs: [] });
    symlinkSync(legacyTag, engineCurrentPath(pin.name));
    expect(migrateLegacyEngineTags()).toEqual([{ name: pin.name, from: legacyTag, to: pin.tag }]);
    expect(exists(join(engineTagRoot(pin.name, pin.tag), ".engine-ready"))).toBe(true);
    expect(exists(engineTagRoot(pin.name, legacyTag))).toBe(false);
    expect(readlinkSync(engineCurrentPath(pin.name))).toBe(pin.tag);
    expect(readEngineManifest(pin.name, pin.tag)?.tag).toBe(pin.tag);
    expect(migrateLegacyEngineTags()).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
