import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importCandidate, scanImports } from "@/lib/store/importScan";

test("scans an Ollama blob and imports by link with the digest from its name", () => {
  const root = mkdtempSync(join(tmpdir(), "maipai-import-test-"));
  const bytes = Buffer.from("ollama-model");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const blob = join(root, "blobs", `sha256-${digest}`); mkdirSync(join(root, "blobs"), { recursive: true }); writeFileSync(blob, bytes);
  const candidates = scanImports({ ollama: root });
  expect(candidates.some((item) => item.digest === digest && item.source === "ollama")).toBe(true);
  const manifest = importCandidate(candidates[0]!, { id: `ollama-${Date.now()}`, roles: ["chat"], licence: "MIT" });
  expect(manifest.source).toBe("ollama");
  expect(manifest.blobs[0]?.digest).toBe(digest);
  rmSync(root, { recursive: true, force: true });
});

test("scans a plain LM Studio model after hashing it", () => {
  const root = mkdtempSync(join(tmpdir(), "maipai-lmstudio-test-"));
  const file = join(root, "model.gguf"); writeFileSync(file, "plain-model");
  expect(scanImports({ "lm-studio": root })[0]?.path).toBe(file);
  rmSync(root, { recursive: true, force: true });
});
