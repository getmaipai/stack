import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/app";
import { getJob, __resetJobsForTests } from "@/lib/jobs";
import { dataDir } from "@/lib/paths";
import { imageLoras, startLoraInstall, __resetImageLoraInstallForTests } from "@/images/loras";


const HF = "https://huggingface.co/owner/name/resolve/main/style.safetensors";
const CIV = "https://civitai.com/api/download/models/12345";
function bytes(seed = "a") {
  const payload = Buffer.alloc(16);
  const header = {
    __metadata__: { base_model: "z-image-turbo" },
    "diffusion_model.layers.0.attention.to_k.lora_A.weight": { dtype: "BF16", shape: [16, 3840], data_offsets: [0, 8] },
    "diffusion_model.layers.0.attention.to_k.lora_B.weight": { dtype: "BF16", shape: [3840, 16], data_offsets: [8, 16] },
  };
  const json = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(json.length));
  payload.write(seed.padEnd(16, "."));
  return Buffer.concat([length, json, payload]);
}
const sha = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");

function scripted(fn: (url: string, headers: Record<string, string>, count: number) => Response) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const url = String(input);
    seen.push({ url, headers });
    return fn(url, headers, seen.length);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

const ok = (buffer: Buffer, status = 200, headers: Record<string, string> = {}) => new Response(buffer, {
  status,
  headers: { "content-length": String(buffer.length), ...headers },
});

const redirect = (url: string) => new Response(null, { status: 302, headers: { location: url } });

async function finish(id: string) {
  for (let i = 0; i < 200 && getJob(id)!.state === "running"; i++) {
    await Bun.sleep(10);
  }
  return getJob(id)!;
}

const dir = join(dataDir, "tmp", "image-lora-install");

beforeEach(() => {
  __resetJobsForTests();
  __resetImageLoraInstallForTests();
  rmSync(dir, { recursive: true, force: true });
});

afterEach(async () => {
  for (const lora of imageLoras.list()) {
    await imageLoras.remove(lora.id);
  }
});

test("Civitai redirects to allowed CDN, token stays at source and hash is checked", async () => {
  const buffer = bytes();
  const { fetch, seen } = scripted((url) => url.startsWith("https://civitai.com/")
    ? redirect("https://civitai-delivery-worker-prod.abc.r2.cloudflarestorage.com/f")
    : ok(buffer));
  const job = startLoraInstall({
    site: "civitai",
    url: CIV,
    name: "Clay",
    licence: "apache-2.0",
    token: "secret",
    sha256Expected: sha(buffer),
  }, { fetch });
  expect(JSON.stringify(job)).not.toContain(CIV);
  const done = await finish(job.id);
  expect(done.state).toBe("done");
  expect(done.result).toMatchObject({ lora: { sha256: sha(buffer) } });
  expect(seen[0]!.headers.authorization).toBe("Bearer secret");
  expect(seen[1]!.headers.authorization).toBeUndefined();
});

test("hash mismatch fails", async () => {
  const { fetch } = scripted(() => ok(bytes()));
  const job = startLoraInstall({
    site: "civitai",
    url: CIV,
    name: "x",
    licence: "mit",
    sha256Expected: "0".repeat(64),
  }, { fetch });
  expect((await finish(job.id)).result).toMatchObject({ code: "hash_mismatch" });
});
test("expected duplicate is rejected before fetch", async () => {
  const b = bytes();
  const { fetch, seen } = scripted(() => ok(b));
  const first = startLoraInstall({ url: HF, name: "x", licence: "mit", sha256Expected: sha(b) }, { fetch });
  await finish(first.id);
  const callsBeforeSecondStart = seen.length;
  expect(() => startLoraInstall({ url: HF, name: "x", licence: "mit", sha256Expected: sha(b) }, { fetch })).toThrow(/already in the library/);
  expect(seen).toHaveLength(callsBeforeSecondStart);
});
test("redirect to an unapproved host is refused", async () => {
  const { fetch } = scripted(() => redirect("https://evil.example.com/file"));
  const job = startLoraInstall({ site: "civitai", url: CIV, name: "x", licence: "mit" }, { fetch });
  expect((await finish(job.id)).result).toMatchObject({ code: "host_not_allowed" });
});
test("Range resumes a partial download", async () => {
  const b = bytes();
  const half = 5;
  const first = scripted(() => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(b.subarray(0, half)));
        setTimeout(() => controller.error(new Error("reset")), 0);
      },
    });
    return new Response(stream, { headers: { "content-length": String(b.length) } });
  });
  const failed = await finish(startLoraInstall({ url: HF, name: "x", licence: "mit" }, { fetch: first.fetch }).id);
  expect(failed.state).toBe("failed");
  const second = scripted(() => new Response(b.subarray(half), {
    status: 206,
    headers: {
      "content-range": `bytes ${half}-${b.length - 1}/${b.length}`,
      "content-length": String(b.length - half),
    },
  }));
  const resumed = await finish(startLoraInstall({ url: HF, name: "x", licence: "mit" }, { fetch: second.fetch }).id);
  expect(resumed).toMatchObject({ state: "done" });
  expect(second.seen[0]!.headers.range).toBe(`bytes=${half}-`);
});
test("legacy HF body still reads licence and tags from card", async () => {
  const buffer = bytes();
  const { fetch, seen } = scripted((url) => url.includes("/api/models/")
    ? new Response(JSON.stringify({ cardData: { license: "apache-2.0" }, tags: ["lora", "picture"] }))
    : ok(buffer));
  const job = startLoraInstall({ url: HF, name: "legacy", classification: "all-ages" }, { fetch });
  const done = await finish(job.id);
  expect(done.state).toBe("done");
  expect(done.result).toMatchObject({
    lora: {
      licence: "apache-2.0",
      classification: "all-ages",
      source_url: HF.replace("resolve", "blob"),
    },
  });
  expect(seen.some((entry) => entry.url.includes("/api/models/owner/name"))).toBe(true);
  expect(JSON.stringify(job.input)).not.toContain("https://");
});

test("one install at a time", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = scripted(() => new Response(new ReadableStream({
    async start(controller) {
      await gate;
      controller.enqueue(new Uint8Array(bytes()));
      controller.close();
    },
  })));
  const job = startLoraInstall({ url: HF, name: "x", licence: "mit" }, { fetch: slow.fetch });
  expect(() => startLoraInstall({ url: HF, name: "y", licence: "mit" }, { fetch: slow.fetch })).toThrow(/Another style/);
  release();
  expect((await finish(job.id)).state).toBe("done");
});

// Regression 2026-11-05: the shared installer threw the video library's LoraError, which the picture route did not recognise, so a plain refusal
// (a link from the wrong host) came back as a 500 from the live Stack. The route is what Home calls, so the refusals are asserted through it.
const post = (body: Record<string, unknown>) => app.request("/stack/v1/image/loras/install", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

test("the route refuses a link from another host with 422 host_not_allowed, not a 500", async () => {
  const response = await post({ url: "https://example.com/x.safetensors", name: "probe" });
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ code: "host_not_allowed" });
});

test("the route refuses a bad Civitai link and a bad hash with 422 and their codes", async () => {
  const link = await post({ site: "civitai", url: "https://civitai.com/models/12345", name: "probe" });
  expect(link.status).toBe(422);
  expect(await link.json()).toMatchObject({ code: "bad_url" });
  const hash = await post({ url: HF, name: "probe", sha256_expected: "not-a-hash" });
  expect(hash.status).toBe(422);
  expect(await hash.json()).toMatchObject({ code: "bad_hash" });
});

test("the route answers 409 duplicate_lora with the existing id when the expected hash is already in the library", async () => {
  const buffer = bytes("r");
  const { fetch } = scripted(() => ok(buffer));
  expect((await finish(startLoraInstall({ url: HF, name: "first", licence: "mit" }, { fetch }).id)).state).toBe("done");
  const existingId = imageLoras.list()[0]!.id;
  const response = await post({ url: HF, name: "again", licence: "mit", sha256_expected: sha(buffer) });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "duplicate_lora", existing_id: existingId });
});

test("the route answers 503 install_busy while a download runs", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slow = scripted(() => new Response(new ReadableStream({
    async start(controller) { await gate; controller.enqueue(new Uint8Array(bytes("q"))); controller.close(); },
  })));
  const job = startLoraInstall({ url: HF, name: "x", licence: "mit" }, { fetch: slow.fetch });
  const busy = await post({ url: HF, name: "y", licence: "mit" });
  expect(busy.status).toBe(503);
  expect(await busy.json()).toMatchObject({ code: "install_busy" });
  release();
  expect((await finish(job.id)).state).toBe("done");
});
