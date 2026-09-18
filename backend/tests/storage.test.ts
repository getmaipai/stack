import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storageAccounting } from "@/lib/store/storage";

test("storage accounting splits model abilities and counts a shared link once", () => {
  const root = mkdtempSync(join(tmpdir(), "maipai-storage-test-"));
  mkdirSync(join(root, "models", "manifests"), { recursive: true });
  mkdirSync(join(root, "logs"), { recursive: true });
  writeFileSync(join(root, "models", "chat.gguf"), "12345");
  writeFileSync(join(root, "models", "voice.gguf"), "1234567");
  symlinkSync(join(root, "models", "chat.gguf"), join(root, "models", "shared.gguf"));
  writeFileSync(join(root, "logs", "stack.log"), "log");
  writeFileSync(join(root, "models", "manifests", "chat.json"), JSON.stringify({ kind: "model", id: "chat", roles: ["chat"], blobs: [{ digest: "chat", sizeBytes: 5, path: join(root, "models", "chat.gguf") }], sizeBytes: 5 }));
  writeFileSync(join(root, "models", "manifests", "voice.json"), JSON.stringify({ kind: "model", id: "voice", roles: ["stt"], blobs: [{ digest: "voice", sizeBytes: 7, path: join(root, "models", "voice.gguf"), shared: true }], sizeBytes: 7 }));
  const report = storageAccounting(root);
  expect(report.byCategory.models).toBe(12);
  expect(report.models.byAbility.chat).toBe(5);
  expect(report.models.byAbility.voice).toBe(7);
  expect(report.models.sharedBytes).toBe(7);
  expect(report.byCategory.logs).toBe(3);
  expect(report.totalBytes).toBe(15);
});
