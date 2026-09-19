import { expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanStorageHygiene, diskFillsSoon, storageHygiene } from "@/lib/hygiene";

const day = 86_400_000;

test("storage hygiene reports exact reclaimable files and only cleans listed ids", () => {
  const root = join(tmpdir(), `maipai-hygiene-${crypto.randomUUID()}`); const now = Date.parse("2026-09-19T12:00:00.000Z");
  mkdirSync(join(root, "models"), { recursive: true }); mkdirSync(join(root, "store", "blobs"), { recursive: true }); mkdirSync(join(root, "engines", "llama", "b1"), { recursive: true }); mkdirSync(join(root, "engines", "llama", "b2"), { recursive: true }); mkdirSync(join(root, "engines", "llama", "b3"), { recursive: true }); mkdirSync(join(root, "logs"), { recursive: true });
  const oldModel = join(root, "models", "old.gguf"); const copy = join(root, "models", "copy.gguf"); const blob = join(root, "store", "blobs", "orphan"); const oldEngine = join(root, "engines", "llama", "b1", "bin"); const log = join(root, "logs", "old.log");
  writeFileSync(oldModel, "model"); writeFileSync(copy, "model"); writeFileSync(blob, "blob"); writeFileSync(oldEngine, "engine"); writeFileSync(log, "log"); utimesSync(log, new Date(now - 31 * day), new Date(now - 31 * day));
  const options = { root, now, retentionDays: 30, models: [{ id: "old", modelPath: oldModel, sizeBytes: 5, lastUsedAt: new Date(now - 31 * day).toISOString() }] };
  const report = storageHygiene(options);
  expect(report.items.map((item) => [item.kind, item.sizeBytes])).toEqual([["unused-model", 5], ["duplicate-file", 5], ["orphan-blob", 4], ["old-engine-build", 6], ["stale-log", 3]]);
  const duplicate = report.items.find((item) => item.kind === "duplicate-file")!;
  expect(cleanStorageHygiene([duplicate.id], options)).toEqual([duplicate]);
  expect(existsSync(oldModel)).toBe(true); expect(existsSync(copy)).toBe(false); expect(existsSync(blob)).toBe(true); expect(() => cleanStorageHygiene(["not-reported"], options)).toThrow("not in the current report");
});

test("disk-full warning needs a positive download trend", () => {
  const now = Date.parse("2026-09-19T12:00:00.000Z");
  expect(diskFillsSoon({ now, freeDiskBytes: 2 * day, downloads: [{ at: new Date(now - day).toISOString(), completedBytes: 0 }, { at: new Date(now).toISOString(), completedBytes: day }] })).toBe(true);
  expect(diskFillsSoon({ now, freeDiskBytes: 2 * day, downloads: [{ at: new Date(now - day).toISOString(), completedBytes: day }, { at: new Date(now).toISOString(), completedBytes: day }] })).toBe(false);
});
