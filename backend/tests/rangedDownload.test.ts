import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rangedDownload } from "@/lib/store/rangedDownload";

const content = Buffer.from("ranged-content-".repeat(20_000));
const digest = createHash("sha256").update(content).digest("hex");
let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => { server?.stop(true); server = null; });

test("uses eight ranged parts and assembles the verified file", async () => {
  server = Bun.serve({ port: 0, fetch(request) { const range = request.headers.get("range"); if (!range) return new Response(content); const match = /bytes=(\d+)-(\d+)/.exec(range)!; const start = Number(match[1]); const end = Number(match[2]); return new Response(content.subarray(start, end + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${content.length}` } }); } });
  const dir = mkdtempSync(join(tmpdir(), "maipai-ranged-test-"));
  try { const destination = join(dir, "model.gguf"); await rangedDownload(server.url.toString(), destination, { expectedSha256: digest, expectedBytes: content.length }); expect(Buffer.from(await Bun.file(destination).arrayBuffer()).equals(content)).toBe(true); expect(existsSync(`${destination}.partial-0`)).toBe(false); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("falls back to the single stream downloader when Range is ignored", async () => {
  server = Bun.serve({ port: 0, fetch: () => new Response(content) });
  const dir = mkdtempSync(join(tmpdir(), "maipai-ranged-fallback-"));
  try { const destination = join(dir, "model.gguf"); await rangedDownload(server.url.toString(), destination, { expectedSha256: digest, expectedBytes: content.length }); expect(Buffer.from(await Bun.file(destination).arrayBuffer()).equals(content)).toBe(true); } finally { rmSync(dir, { recursive: true, force: true }); }
});
