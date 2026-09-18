import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { putBlob } from "@/lib/store/blobs";
import { readModelManifest, removeModelManifest, writeModelManifest, pruneUnreferenced } from "@/lib/store/manifests";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("a blob shared by two manifests survives one remove and is pruned after the grace period", () => {
  const dir = mkdtempSync(join(tmpdir(), "maipai-store-test-")); dirs.push(dir);
  const source = join(dir, "blob.bin"); writeFileSync(source, "shared");
  const digest = createHash("sha256").update("shared").digest("hex");
  const blob = putBlob(source, digest);
  for (const id of ["one", "two"]) writeModelManifest({ kind: "model", id, source: "test", roles: ["chat"], blobs: [{ digest, sizeBytes: blob.sizeBytes, path: blob.path }], sizeBytes: blob.sizeBytes, createdAt: new Date().toISOString() });
  removeModelManifest("one");
  expect(existsSync(blob.path)).toBe(true);
  removeModelManifest("two");
  expect(existsSync(blob.path)).toBe(true);
  expect(pruneUnreferenced(Date.now() + 3_600_001)).toContain(digest);
  expect(existsSync(blob.path)).toBe(false);
  expect(readModelManifest("two")).toBeNull();
});
