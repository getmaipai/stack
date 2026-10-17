import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeRequirements } from "@/lib/uvEnvironment";
import { requirementsFileFor } from "@/speech/pocketTts";

test("the requirements file uv syncs is a real file on disk with the pinned hashes", async () => {
  const source = requirementsFileFor("darwin", "arm64")!;
  const root = mkdtempSync(join(tmpdir(), "uvreq-"));
  const target = await materializeRequirements(root, source);
  expect(target.startsWith("/$bunfs")).toBe(false);
  expect(readFileSync(target, "utf8")).toContain("--hash=sha256:");
});
