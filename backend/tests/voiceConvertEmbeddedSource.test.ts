import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { extractVoiceConvertSource } from "@/voiceConvert/voiceConvert";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function archiveBytes(): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), "voice-convert-archive-"));
  dirs.push(dir);
  mkdirSync(join(dir, "source", "soulxsinger", "models"), { recursive: true });
  await Bun.write(join(dir, "source", "README.txt"), "archive root marker");
  await Bun.write(join(dir, "source", "soulxsinger", "models", "soulxsinger_svc.py"), "embedded source ok");
  const archive = join(dir, "source.tar.gz");
  const tar = spawn(["tar", "-czf", archive, "-C", dir, "source"], { stdout: "pipe", stderr: "pipe" });
  expect(await tar.exited).toBe(0);
  return readFileSync(archive);
}

test("verifies embedded archive bytes and extracts using a real temporary archive", async () => {
  const bytes = await archiveBytes();
  const dir = mkdtempSync(join(tmpdir(), "voice-convert-destination-"));
  dirs.push(dir);
  const destination = join(dir, "extracted");
  await extractVoiceConvertSource("missing-embedded-asset", createHash("sha256").update(bytes).digest("hex"), destination, async () => bytes);
  expect(await Bun.file(join(destination, "soulxsinger", "models", "soulxsinger_svc.py")).text()).toBe("embedded source ok");
  expect(readdirSync(dir).filter((name) => name.endsWith(".tar.gz"))).toEqual([]);
});

test("rejects an embedded archive with a wrong pinned hash", async () => {
  const bytes = await archiveBytes();
  const dir = mkdtempSync(join(tmpdir(), "voice-convert-destination-"));
  dirs.push(dir);
  await expect(extractVoiceConvertSource("missing-embedded-asset", "0".repeat(64), join(dir, "extracted"), async () => bytes))
    .rejects.toThrow("The pinned voice conversion source did not verify.");
  expect(readdirSync(dir)).toEqual([]);
});

test("reads the embedded asset through the supplied reader, without opening its asset path", async () => {
  const bytes = await archiveBytes();
  const dir = mkdtempSync(join(tmpdir(), "voice-convert-destination-"));
  dirs.push(dir);
  let readPath = "";
  await extractVoiceConvertSource("/$bunfs/embedded-only.tar.gz", createHash("sha256").update(bytes).digest("hex"), join(dir, "out"), async (path) => {
    readPath = path;
    return bytes;
  });
  expect(readPath).toBe("/$bunfs/embedded-only.tar.gz");
  expect(existsSync(join(dir, "out", "soulxsinger", "models", "soulxsinger_svc.py"))).toBe(true);
});
