import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadUrl, sha256OfFile } from "@/lib/download";

const CONTENT = Buffer.from("x".repeat(50_000), "utf8");
const SHA256 = createHash("sha256").update(CONTENT).digest("hex");
let flakyServed = false;
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/flaky-once" && !flakyServed) {
      flakyServed = true;
      return new Response(null, { status: 500 });
    }
    const range = request.headers.get("range");
    if (range) {
      const start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
      return new Response(CONTENT.subarray(start), { status: 206, headers: { "content-length": String(CONTENT.length - start) } });
    }
    return new Response(CONTENT, { status: 200, headers: { "content-length": String(CONTENT.length) } });
  },
});
afterAll(() => server.stop(true));

let workDir = "";
afterEach(() => { if (workDir) rmSync(workDir, { recursive: true, force: true }); workDir = ""; });
function dest(): string {
  workDir = mkdtempSync(join(tmpdir(), "maipai-download-test-"));
  return join(workDir, "file.bin");
}

describe("downloadUrl", () => {
  test("downloads and verifies a real file", async () => {
    const path = dest();
    await downloadUrl(`${server.url}`, path, { expectedSha256: SHA256, expectedBytes: CONTENT.length });
    expect(readFileSync(path)).toEqual(CONTENT);
  });

  test("a checksum mismatch removes the partial file and throws", async () => {
    const path = dest();
    await expect(downloadUrl(`${server.url}`, path, { expectedSha256: "0".repeat(64), expectedBytes: CONTENT.length })).rejects.toThrow(/sha256/);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.part`)).toBe(false);
  });

  test("a size mismatch removes the partial file and throws", async () => {
    const path = dest();
    await expect(downloadUrl(`${server.url}`, path, { expectedSha256: SHA256, expectedBytes: CONTENT.length + 1 })).rejects.toThrow(/size/);
    expect(existsSync(path)).toBe(false);
  });

  test("resumes from an existing part file", async () => {
    const path = dest();
    writeFileSync(`${path}.part`, CONTENT.subarray(0, 20_000));
    await downloadUrl(`${server.url}`, path, { expectedSha256: SHA256, expectedBytes: CONTENT.length });
    expect(readFileSync(path)).toEqual(CONTENT);
  });

  test("skips entirely when the destination already exists", async () => {
    const path = dest();
    writeFileSync(path, CONTENT);
    await downloadUrl(`${server.url}`, path, { expectedSha256: "0".repeat(64) });
    expect(readFileSync(path)).toEqual(CONTENT);
  });

  test("retries a transient server error", async () => {
    flakyServed = false;
    const path = dest();
    await downloadUrl(`${server.url}/flaky-once`, path, { expectedSha256: SHA256, expectedBytes: CONTENT.length });
    expect(readFileSync(path)).toEqual(CONTENT);
  }, 15_000);

  test("applies the configured cap at the streaming seam", async () => {
    const path = dest(); let now = 0;
    await downloadUrl(`${server.url}`, path, { expectedSha256: SHA256, expectedBytes: CONTENT.length, downloadCapMbps: 1, now: () => now, sleep: async (ms) => { now += ms; } });
    // 50,000 bytes at 1 Mbps needs 400 ms, with no more than 10% drift.
    expect(now).toBeGreaterThanOrEqual(360); expect(now).toBeLessThanOrEqual(440);
  });
});

test("sha256OfFile matches node crypto", async () => {
  const path = dest();
  writeFileSync(path, CONTENT);
  expect(await sha256OfFile(path)).toBe(SHA256);
});
