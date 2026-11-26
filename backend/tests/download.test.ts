import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadUrl, fetchModelFile, setDownloadHfAuth, sha256OfFile } from "@/lib/download";

const CONTENT = Buffer.from("x".repeat(50_000), "utf8");
const SHA256 = createHash("sha256").update(CONTENT).digest("hex");
let flakyServed = false;
let rangeRequested = false;
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/flaky-once" && !flakyServed) {
      flakyServed = true;
      return new Response(null, { status: 500 });
    }
    const range = request.headers.get("range");
    if (range) rangeRequested = true;
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
    rangeRequested = false;
    writeFileSync(`${path}.part`, CONTENT.subarray(0, 20_000));
    await downloadUrl(`${server.url}`, path, { expectedSha256: SHA256, expectedBytes: CONTENT.length });
    expect(readFileSync(path)).toEqual(CONTENT);
    expect(rangeRequested).toBe(true);
  });

  test("reports a smoothed rate and per-file running, verifying and done states", async () => {
    const path = dest();
    const updates: Array<{ bytesPerSecond?: number; itemId?: string; itemLabel?: string; itemState?: string }> = [];
    await downloadUrl(`${server.url}`, path, { expectedSha256: SHA256, expectedBytes: CONTENT.length, onProgress: (progress) => updates.push(progress) });
    expect(updates.some((update) => update.itemState === "running" && update.itemId === "file.bin" && update.itemLabel === "file.bin" && (update.bytesPerSecond ?? 0) > 0)).toBe(true);
    expect(updates.some((update) => update.itemState === "verifying")).toBe(true);
    expect(updates.at(-1)?.itemState).toBe("done");
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

test("a killed downloader resumes its partial file after process restart and verifies the checksum", async () => {
  const content = Buffer.from("resume across process restarts\n".repeat(16_384));
  const digest = createHash("sha256").update(content).digest("hex");
  let rangeRequested = false;
  const source = Bun.serve({
    port: 0,
    fetch(request) {
      const range = request.headers.get("range");
      const offset = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
      if (range) rangeRequested = true;
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (let start = offset; start < content.length; start += 16_384) {
            await new Promise((resolve) => setTimeout(resolve, 4));
            controller.enqueue(content.subarray(start, Math.min(content.length, start + 16_384)));
          }
          controller.close();
        },
      });
      const length = content.length - offset;
      return new Response(body, { status: range ? 206 : 200, headers: { "content-length": String(length), ...(range ? { "content-range": `bytes ${offset}-${content.length - 1}/${content.length}` } : {}) } });
    },
  });
  const directory = mkdtempSync(join(tmpdir(), "maipai-download-restart-"));
  const destination = join(directory, "restart.bin");
  const helper = join(import.meta.dir, "helpers", "download-child.ts");
  const run = () => Bun.spawn([process.execPath, "run", helper], {
    cwd: process.cwd(),
    env: { ...process.env, MAIPAI_DOWNLOAD_TEST_URL: String(source.url), MAIPAI_DOWNLOAD_TEST_DESTINATION: destination, MAIPAI_DOWNLOAD_TEST_SHA256: digest, MAIPAI_DOWNLOAD_TEST_BYTES: String(content.length) },
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    const interrupted = run();
    const part = `${destination}.part`;
    for (let attempt = 0; attempt < 500 && (!existsSync(part) || statSync(part).size < 32_768); attempt += 1) {
      if (interrupted.exitCode !== null) throw new Error("The initial download finished before it could be interrupted.");
      await new Promise((resolve) => setTimeout(resolve, 4));
    }
    expect(existsSync(part)).toBe(true);
    expect(statSync(part).size).toBeGreaterThan(0);
    interrupted.kill("SIGKILL");
    await interrupted.exited;
    expect(existsSync(part)).toBe(true);

    const resumed = run();
    const exitCode = await resumed.exited;
    if (exitCode !== 0) throw new Error(await new Response(resumed.stderr).text());
    expect(rangeRequested).toBe(true);
    expect(readFileSync(destination)).toEqual(content);
  } finally {
    source.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);

describe("Hugging Face token", () => {
  const OK = { expectedSha256: SHA256, expectedBytes: CONTENT.length };
  const seen: Array<{ host: string; path: string; auth: string | null }> = [];
  const cdn = Bun.serve({ port: 0, fetch(request) { seen.push({ host: "cdn", path: new URL(request.url).pathname, auth: request.headers.get("authorization") }); return new Response(CONTENT, { headers: { "content-length": String(CONTENT.length) } }); } });
  const hub = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      seen.push({ host: "hub", path: url.pathname, auth: request.headers.get("authorization") });
      if (url.pathname === "/gated") return request.headers.get("authorization") === "Bearer secret-login" ? new Response(CONTENT, { headers: { "content-length": String(CONTENT.length) } }) : new Response(null, { status: 401 });
      if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: `http://localhost:${cdn.port}/file` } });
      return new Response(CONTENT, { headers: { "content-length": String(CONTENT.length) } });
    },
  });
  afterAll(() => { cdn.stop(true); hub.stop(true); setDownloadHfAuth("https://huggingface.co", ""); });
  const hubUrl = (path: string) => `http://localhost:${hub.port}${path}`;
  const point = (token: string) => { seen.length = 0; setDownloadHfAuth(`http://localhost:${hub.port}`, token); };

  test("sends the login to the model host", async () => {
    point("secret-login");
    await downloadUrl(hubUrl("/gated"), dest(), OK);
    expect(seen[0]?.auth).toBe("Bearer secret-login");
  });
  test("sends nothing when no login is set, and a gated file says 401", async () => {
    point("");
    const res = await fetchModelFile(hubUrl("/gated"), {});
    expect(res.status).toBe(401);
    expect(seen.every((s) => s.auth === null)).toBe(true);
  });
  test("never sends the login to another host", async () => {
    point("secret-login");
    await downloadUrl(`http://127.0.0.1:${cdn.port}/file`, dest(), OK);
    expect(seen).toEqual([{ host: "cdn", path: "/file", auth: null }]);
  });
  test("drops the login on a redirect to another host", async () => {
    point("secret-login");
    await downloadUrl(hubUrl("/redirect"), dest(), OK);
    expect(seen.find((s) => s.host === "hub")?.auth).toBe("Bearer secret-login");
    expect(seen.find((s) => s.host === "cdn")?.auth).toBeNull();
  });
  test("an explicit Authorization header wins", async () => {
    point("secret-login");
    await downloadUrl(hubUrl("/plain"), dest(), { ...OK, headers: { Authorization: "Bearer caller" } });
    expect(seen[0]?.auth).toBe("Bearer caller");
  });
});
