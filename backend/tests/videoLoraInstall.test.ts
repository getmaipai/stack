// VIDEO-LORA-06: the video.lora.install job. No network: every request goes through a scripted fetch. Files are tiny synthetic
// safetensors (a real header shape, a few bytes of data), as in videoLtx25Lora.test.ts.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/app";
import { __resetJobsForTests, getJob } from "@/lib/jobs";
import { dataDir } from "@/lib/paths";
import { listLoras, removeLora } from "@/video/loras";
import { __resetLoraInstallForTests, parseInstallUrl, startVideoLoraInstall, sweepInstallParts, type VideoLoraInstallInput } from "@/video/loraInstall";

const GB = 1_073_741_824;
const HF = "https://huggingface.co/owner/name/resolve/main/style.safetensors";
const CIV = "https://civitai.com/api/download/models/12345";

/** A safetensors file with LTX-style LoRA tensors (header only plus 8 data bytes; the data offsets are [0, 0]). */
function loraBytes(seed = "a", width = 4096): Buffer {
  const header: Record<string, unknown> = { __metadata__: { note: seed } };
  for (const part of ["to_k", "to_q"]) {
    header[`diffusion_model.transformer_blocks.0.attn1.${part}.lora_A.weight`] = { dtype: "BF16", shape: [16, width], data_offsets: [0, 0] };
    header[`diffusion_model.transformer_blocks.0.attn1.${part}.lora_B.weight`] = { dtype: "BF16", shape: [width, 16], data_offsets: [0, 0] };
  }
  const json = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(json.length));
  return Buffer.concat([length, json, Buffer.from(seed.padEnd(8, "."))]);
}
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

interface Seen { url: string; headers: Record<string, string> }
function scripted(handler: (url: string, headers: Record<string, string>, n: number) => Response): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url, headers });
    return handler(url, headers, seen.length);
  }) as unknown as typeof fetch;
  return { fetch: fn, seen };
}
const ok = (bytes: Buffer, status = 200, extra: Record<string, string> = {}): Response => new Response(bytes, { status, headers: { "content-length": String(bytes.length), ...extra } });
const redirect = (to: string): Response => new Response(null, { status: 302, headers: { location: to } });
const base = (over: Partial<VideoLoraInstallInput> = {}): VideoLoraInstallInput => ({ site: "huggingface", url: HF, name: "Clay", licence: "apache-2.0", classification: "all-ages", baseModel: "ltx-2.5", ...over });
async function finish(id: string) {
  for (let i = 0; i < 200 && getJob(id)!.state === "running"; i++) await Bun.sleep(10);
  return getJob(id)!;
}
const parts = (): string[] => { try { return readdirSync(join(dataDir, "tmp", "video-lora-install")); } catch { return []; } };

beforeEach(() => { __resetJobsForTests(); __resetLoraInstallForTests(); rmSync(join(dataDir, "tmp", "video-lora-install"), { recursive: true, force: true }); });
afterEach(async () => { for (const lora of listLoras()) await removeLora(lora.id); });

test("a Hugging Face file installs: redirect to the CDN, token only to huggingface.co, hash recorded, job names nothing", async () => {
  const bytes = loraBytes("a");
  const { fetch, seen } = scripted((url) => url.startsWith("https://huggingface.co/") ? redirect("https://cdn-lfs.huggingface.co/blob/abc") : ok(bytes));
  const job = startVideoLoraInstall(base({ token: "hf_secret_token", sha256Expected: sha(bytes).toUpperCase() }), { fetch });
  expect(JSON.stringify(job)).not.toContain("owner/name");
  expect(JSON.stringify(job)).not.toContain("hf_secret_token");
  const done = await finish(job.id);
  expect(done.state).toBe("done");
  expect(done.result).toMatchObject({ lora: { sha256: sha(bytes), base_model: "ltx-2.5", classification: "all-ages" } });
  expect(seen).toHaveLength(2);
  expect(seen[0]!.headers.authorization).toBe("Bearer hf_secret_token");
  expect(seen[1]!.headers.authorization).toBeUndefined();
  expect(JSON.stringify(getJob(job.id))).not.toContain("hf_secret_token");
  expect(parts()).toEqual([]);
  expect(listLoras()).toHaveLength(1);
});

test("a redirect to a host off the allow list is refused and nothing is saved; the token never goes there", async () => {
  const { fetch, seen } = scripted((url) => url.startsWith("https://huggingface.co/") ? redirect("https://evil.example.com/steal") : ok(loraBytes()));
  const done = await finish(startVideoLoraInstall(base({ token: "hf_secret_token" }), { fetch }).id);
  expect(done.state).toBe("failed");
  expect(done.reason).toContain("host_not_allowed");
  expect(seen.map((s) => s.url)).toEqual([HF]);
  expect(parts()).toEqual([]);
  const plain = scripted((url) => url.startsWith("https://huggingface.co/") ? redirect("http://cdn-lfs.huggingface.co/x") : ok(loraBytes()));
  expect((await finish(startVideoLoraInstall(base(), { fetch: plain.fetch }).id)).reason).toContain("host_not_allowed");
});

test("Civitai: only civitai.com download links, query string dropped, key as a Bearer header to civitai.com only", async () => {
  expect(() => parseInstallUrl("civitai", "https://civitai.com/models/1")).toThrow();
  expect(() => parseInstallUrl("civitai", "https://example.com/api/download/models/1")).toThrow();
  expect(() => parseInstallUrl("huggingface", CIV)).toThrow();
  expect(parseInstallUrl("civitai", `${CIV}?token=abc`).href).toBe(CIV);
  const bytes = loraBytes("c");
  const { fetch, seen } = scripted((url) => url.startsWith("https://civitai.com/") ? redirect("https://civitai-delivery-worker-prod.abc123.r2.cloudflarestorage.com/f?sig=1") : ok(bytes));
  const done = await finish(startVideoLoraInstall(base({ site: "civitai", url: `${CIV}?token=abc`, token: "civ_key" }), { fetch }).id);
  expect(done.state).toBe("done");
  expect(seen[0]!.url).toBe(CIV);
  expect(seen[0]!.headers.authorization).toBe("Bearer civ_key");
  expect(seen[1]!.headers.authorization).toBeUndefined();
});

test("a dropped connection keeps the .part file and Try again resumes with Range from its length", async () => {
  const bytes = loraBytes("r");
  const half = bytes.length - 6;
  let calls = 0;
  const first = scripted(() => {
    calls += 1;
    let sent = false;
    const stream = new ReadableStream({ pull(controller) { if (!sent) { sent = true; controller.enqueue(new Uint8Array(bytes.subarray(0, half))); return; } controller.error(new Error("connection reset")); } });
    return new Response(stream, { status: 200, headers: { "content-length": String(bytes.length) } });
  });
  const failed = await finish(startVideoLoraInstall(base(), { fetch: first.fetch }).id);
  expect(failed.state).toBe("failed");
  expect(failed.reason).toContain("download_failed");
  expect(calls).toBe(1);
  expect(parts()).toHaveLength(1);
  const second = scripted((_url, headers) => headers.range === `bytes=${half}-` ? new Response(bytes.subarray(half), { status: 206, headers: { "content-range": `bytes ${half}-${bytes.length - 1}/${bytes.length}`, "content-length": String(bytes.length - half) } }) : ok(Buffer.from("wrong")));
  const done = await finish(startVideoLoraInstall(base(), { fetch: second.fetch }).id);
  expect(done.state).toBe("done");
  expect(second.seen[0]!.headers.range).toBe(`bytes=${half}-`);
  expect(done.result).toMatchObject({ lora: { sha256: sha(bytes) } });
  expect(parts()).toEqual([]);
});

test("a server that ignores Range (200) restarts from zero instead of gluing bytes together", async () => {
  const bytes = loraBytes("s");
  mkdirSync(join(dataDir, "tmp", "video-lora-install"), { recursive: true });
  const url = parseInstallUrl("huggingface", HF);
  const name = `lora-install-${createHash("sha256").update(url.href).digest("hex").slice(0, 16)}.part`;
  writeFileSync(join(dataDir, "tmp", "video-lora-install", name), Buffer.from("stale bytes"));
  const { fetch, seen } = scripted(() => ok(bytes));
  const done = await finish(startVideoLoraInstall(base(), { fetch }).id);
  expect(seen[0]!.headers.range).toBe("bytes=11-");
  expect(done.state).toBe("done");
  expect(done.result).toMatchObject({ lora: { sha256: sha(bytes) } });
});

test("an HTML error page saved as .safetensors is refused by the header check and the part is removed", async () => {
  const { fetch } = scripted(() => ok(Buffer.from("<html><body>Please sign in to download this model</body></html>")));
  const done = await finish(startVideoLoraInstall(base(), { fetch }).id);
  expect(done.state).toBe("failed");
  expect(done.reason).toContain("not_safetensors");
  expect(parts()).toEqual([]);
  expect(listLoras()).toEqual([]);
});

test("a hash that differs from the published one is refused and nothing is added", async () => {
  const { fetch } = scripted(() => ok(loraBytes("h")));
  const done = await finish(startVideoLoraInstall(base({ sha256Expected: "0".repeat(64) }), { fetch }).id);
  expect(done.reason).toContain("hash_mismatch");
  expect(done.result).toMatchObject({ code: "hash_mismatch" });
  expect(parts()).toEqual([]);
  expect(listLoras()).toEqual([]);
});

test("a file over 4 GB is refused from Content-Length before any byte is saved", async () => {
  const { fetch } = scripted(() => new Response("x", { status: 200, headers: { "content-length": String(4 * GB + 1) } }));
  const done = await finish(startVideoLoraInstall(base(), { fetch }).id);
  expect(done.reason).toContain("too_large");
  expect(parts()).toEqual([]);
});

test("a sign-in demand says what to do, with and without a token", async () => {
  const none = await finish(startVideoLoraInstall(base(), { fetch: scripted(() => new Response("no", { status: 401 })).fetch }).id);
  expect(none.reason).toContain("token_needed");
  const bad = await finish(startVideoLoraInstall(base({ token: "t" }), { fetch: scripted(() => new Response("no", { status: 403 })).fetch }).id);
  expect(bad.reason).toContain("token_refused");
  expect(bad.reason).not.toContain("Bearer");
});

test("a duplicate by hash: refused before any download when the hash is expected, and answered with the existing id after one", async () => {
  const bytes = loraBytes("d");
  const { fetch, seen } = scripted(() => ok(bytes));
  expect((await finish(startVideoLoraInstall(base(), { fetch }).id)).state).toBe("done");
  const before = seen.length;
  const existingId = listLoras()[0]!.id;
  expect(() => startVideoLoraInstall(base({ sha256Expected: sha(bytes) }), { fetch })).toThrow(/already in the library/);
  expect(seen.length).toBe(before);
  const again = await finish(startVideoLoraInstall(base(), { fetch }).id);
  expect(again.state).toBe("failed");
  expect(again.result).toMatchObject({ code: "duplicate_lora", existing_id: existingId });
  const response = await app.request("/stack/v1/video/loras/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "huggingface", url: HF, name: "x", licence: "apache-2.0", sha256_expected: sha(bytes) }) });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "duplicate_lora", existing_id: existingId });
});

test("an LTX file with no declared base is refused; a declared 2.3 style installs untested", async () => {
  const { fetch } = scripted(() => ok(loraBytes("b")));
  const older = scripted(() => ok(loraBytes("c")));
  const retired = await finish(startVideoLoraInstall(base({ baseModel: "ltx-2.3" }), { fetch: older.fetch }).id);
  expect(retired.state).toBe("done");
  expect((retired.result as { lora?: { base_model?: string } }).lora?.base_model).toBe("ltx-2.3");
  const pending = startVideoLoraInstall(base({ baseModel: null }), { fetch });
  const done = await finish(pending.id);
  expect(done.state).toBe("failed");
  expect(done.reason).toContain("wrong_base_model");
  const wanJob = startVideoLoraInstall(base({ baseModel: "wan2.2-ti2v-5b" }), { fetch });
  const wan = await finish(wanJob.id);
  expect(wan.reason).toContain("wrong_base_model");
});

test("one download at a time, the route validates its body, and a stale .part is swept", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slow = scripted(() => { const stream = new ReadableStream({ async start(controller) { await gate; controller.enqueue(new Uint8Array(loraBytes("o"))); controller.close(); } }); return new Response(stream, { status: 200 }); });
  const job = startVideoLoraInstall(base(), { fetch: slow.fetch });
  expect(() => startVideoLoraInstall(base(), { fetch: slow.fetch })).toThrow(/Another style/);
  const busy = await app.request("/stack/v1/video/loras/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "huggingface", url: HF, name: "x", licence: "apache-2.0" }) });
  expect(busy.status).toBe(503);
  release();
  expect((await finish(job.id)).state).toBe("done");
  const bad = await app.request("/stack/v1/video/loras/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "huggingface", url: "https://example.com/x.safetensors", name: "x", licence: "mit" }) });
  expect(bad.status).toBe(422);
  expect(await bad.json()).toMatchObject({ code: "host_not_allowed" });
  mkdirSync(join(dataDir, "tmp", "video-lora-install"), { recursive: true });
  const old = join(dataDir, "tmp", "video-lora-install", "lora-install-old.part");
  writeFileSync(old, "x");
  expect(sweepInstallParts(Date.now() + 25 * 3_600_000)).toBe(1);
  expect(existsSync(old)).toBe(false);
});
