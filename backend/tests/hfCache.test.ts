import { expect, test } from "bun:test";
import { mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hfBlobsRoot, hfRefsRoot, hfRepoRoot } from "@/lib/store/layout";
import { readHfFile, writeHfFile } from "@/lib/store/hfCache";

test("a model written in the HF layout has a snapshot link into blobs", () => {
  const repo = `test-org/test-model-${Date.now()}`;
  const cached = writeHfFile({ repo, revision: "abc123", filePath: "model.gguf", bytes: new TextEncoder().encode("gguf") });
  expect(cached.digest).toHaveLength(64);
  expect(readlinkSync(cached.path)).toBe(join("..", "..", "blobs", cached.digest));
  expect(Bun.file(join(hfRefsRoot(repo), "main")).text()).resolves.toBe("abc123");
  expect(Bun.file(join(hfBlobsRoot(repo), cached.digest)).text()).resolves.toBe("gguf");
  expect(readHfFile(repo, "abc123", "model.gguf")?.digest).toBe(cached.digest);
  rmSync(hfRepoRoot(repo), { recursive: true, force: true });
});
