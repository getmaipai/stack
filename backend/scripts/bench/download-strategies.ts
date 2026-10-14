/**
 * INSTALL-DL-BENCH-01: compare the production single stream, the existing
 * ranged helper at 4/8 segments, and parallel independent files. Run with
 * `bun run scripts/bench/download-strategies.ts` from backend/.
 * Only a temporary local file and loopback server are created.
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { downloadUrl } from "@/lib/download";
import { rangedDownload } from "@/lib/store/rangedDownload";

const BYTES = 320 * 1024 * 1024;
const CHUNK = 256 * 1024;
const THROTTLE_BYTES_PER_SEC = 12 * 1024 * 1024;
const REPEATS = 3;
const tmp = mkdtempSync(join(tmpdir(), "stack-dlbench-"));
const source = join(tmp, "payload.bin");
const block = Buffer.alloc(CHUNK);
for (let i = 0; i < block.length; i += 1) block[i] = (i * 131 + (i >>> 7) + 17) & 255;
const fd = await import("node:fs/promises").then(({ open }) => open(source, "w"));
for (let n = 0; n < BYTES / CHUNK; n += 1) await fd.write(block);
await fd.close();
const hash = createHash("sha256");
for await (const part of createReadStream(source)) hash.update(part);
const sha256 = hash.digest("hex");
const started = new Map<string, number>();
const partHashes = Array.from({ length: 4 }, (_, i) => sha256OfRange(source, i * BYTES / 4, (i + 1) * BYTES / 4 - 1));
const server = createServer(async (req, res) => {
  const isPartFile = /^\/file-[0-3]$/.test(req.url ?? "");
  const partIndex = isPartFile ? Number((req.url ?? "").slice(-1)) : 0;
  const partBytes = BYTES / 4;
  const baseStart = 0;
  const baseEnd = isPartFile ? partBytes - 1 : BYTES - 1;
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  let start = range ? Number(range[1]) : baseStart;
  let end = range?.[2] ? Number(range[2]) : baseEnd;
  if (start < baseStart || start > baseEnd || end < start) { res.writeHead(416).end(); return; }
  end = Math.min(end, baseEnd);
  const ranged = Boolean(range);
  res.writeHead(ranged ? 206 : 200, {
    "Accept-Ranges": "bytes", "Content-Length": end - start + 1,
    ...(ranged ? { "Content-Range": `bytes ${start}-${end}/${BYTES}` } : {}),
  });
  const id = req.url ?? "/";
  const t0 = performance.now();
  started.set(id, (started.get(id) ?? 0) + 1);
  const sourceStart = isPartFile ? partIndex * partBytes + start : start;
  const sourceEnd = isPartFile ? partIndex * partBytes + end : end;
  const stream = createReadStream(source, { start: sourceStart, end: sourceEnd, highWaterMark: CHUNK });
  let pending = Promise.resolve();
  stream.on("data", (data: Buffer) => {
    stream.pause();
    pending = new Promise<void>((resolve) => setTimeout(resolve, data.length / THROTTLE_BYTES_PER_SEC * 1000))
      .then(() => { if (!res.destroyed) res.write(data); stream.resume(); });
  });
  stream.on("end", async () => {
    await pending;
    res.end();
    console.log(`HTTP ${id} ${ranged ? `${start}-${end}` : "full"}: ${((performance.now() - t0) / 1000).toFixed(3)}s`);
  });
  stream.on("error", (e) => res.destroy(e));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("Loopback server failed to bind");
const base = `http://127.0.0.1:${address.port}`;
const results: Record<string, number[]> = { current: [], ranged4: [], ranged8: [], parallel4: [] };
async function time(label: string, repeat: number, run: (dest: string) => Promise<void>): Promise<void> {
  const dest = join(tmp, `${label}-${repeat}.bin`);
  const before = performance.now();
  await run(dest);
  const seconds = (performance.now() - before) / 1000;
  if (statSync(dest).size !== BYTES) throw new Error(`${label} produced an incorrect size`);
  results[label]!.push(BYTES / (1024 * 1024) / seconds);
  rmSync(dest, { force: true });
}
try {
  // Rotate order to reduce warm-up/order bias; pair by repeat index.
  const rows = ["current", "ranged4", "ranged8", "parallel4"];
  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    for (let shift = 0; shift < rows.length; shift += 1) {
      const label = rows[(shift + repeat) % rows.length]!;
      if (label === "current") await time(label, repeat, (dest) => downloadUrl(`${base}/model`, dest, { expectedSha256: sha256, expectedBytes: BYTES }));
      else if (label === "ranged4" || label === "ranged8") {
        const parts = label === "ranged4" ? 4 : 8;
        await time(label, repeat, (dest) => rangedDownload(`${base}/model`, dest, { expectedSha256: sha256, expectedBytes: BYTES, parts }));
      } else {
        await time(label, repeat, async (dest) => {
          const partBytes = BYTES / 4;
          const paths = Array.from({ length: 4 }, (_, i) => `${dest}.part${i}`);
          await Promise.all(paths.map((path, i) => downloadUrl(`${base}/file-${i}`, path, {
            expectedSha256: partHashes[i]!, expectedBytes: partBytes,
          })));
          const output = await import("node:fs/promises").then(({ open }) => open(dest, "w"));
          for (const path of paths) {
            const input = createReadStream(path);
            for await (const bytes of input) await output.write(bytes);
            rmSync(path, { force: true });
          }
          await output.close();
        });
      }
    }
  }
} finally {
  server.close();
  await once(server, "close");
  rmSync(tmp, { recursive: true, force: true });
}
function sha256OfRange(path: string, start: number, end: number): string {
  // Parallel-file test serves four independently pinned files by exact byte range.
  // A small hash input is streamed from the deterministic source.
  const fs = require("node:fs");
  const hash = createHash("sha256");
  const fd = fs.openSync(path, "r");
  const buffer = Buffer.alloc(CHUNK);
  for (let position = start; position <= end;) {
    const length = Math.min(buffer.length, end - position + 1);
    const read = fs.readSync(fd, buffer, 0, length, position);
    if (read !== length) throw new Error("Unexpected EOF while hashing a payload slice");
    hash.update(buffer.subarray(0, read));
    position += read;
  }
  fs.closeSync(fd);
  return hash.digest("hex");
}
const averages = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length]));
const paired: Record<string, number[]> = {};
for (const strategy of Object.keys(results).filter((x) => x !== "current")) paired[strategy] = results[strategy]!.map((v, i) => v - results.current![i]!);
function interval(values: number[]): [number, number] {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((s, x) => s + (x - mean) ** 2, 0) / (values.length - 1));
  const t = values.length === 3 ? 4.303 : 2.776;
  const margin = t * sd / Math.sqrt(values.length);
  return [mean - margin, mean + margin];
}
console.log(JSON.stringify({ source: "local throttled loopback; deterministic 320 MiB payload", throttleMiBps: 12, repeats: REPEATS, mibPerSecond: results, means: averages, pairedDifferenceMiBps: paired, paired95: Object.fromEntries(Object.entries(paired).map(([k, v]) => [k, interval(v)])), requests: Object.fromEntries(started) }, null, 2));
