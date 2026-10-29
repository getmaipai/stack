// LIKENESS-01 (Stack half): Home's signed proofs for a picture, video or style that looks like a household adult.
// Covers the proof itself (valid, expired, forged, copied to another picture, wrong purpose, over-long, no key), the
// trust key (first key trusted, a different one only when signed by the old one), the video route's `household_photo`
// source, the picture routes' declared sources, likeness LoRAs (import with and without a proof, use needs a proof),
// and the check made again when a queued job actually starts. A scripted worker stands in for the models.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign as signBytes, type KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly } from "@/lib/governor";
import { __resetJobsForTests, getJob } from "@/lib/jobs";
import { __resetUsedProofsForTests, __setLikenessClockForTests, LikenessError, photoBind, registerTrust, verifyProof, type ProofPurpose } from "@/lib/likeness";
import { registerVideoJobs } from "@/video/jobs";
import { registerImageJobs } from "@/images/jobs";
import { importLora, resolveLoras, updateLora, LoraError as VideoLoraError } from "@/video/loras";
import { imageLoras } from "@/images/loras";
import { LoraError } from "@/lib/media/loraLibrary";
import { __resetProvenanceForTests, recordGeneratedImage, wasGeneratedHere } from "@/video/provenance";
import { videoGen, type VideoGenDeps, type WorkerHandle as VideoHandle, type WorkerReply as VideoReply, type WorkerRequest as VideoRequest } from "@/video/videoGen";
import { imageGen, type ImageGenDeps, type WorkerHandle as ImageHandle, type WorkerReply as ImageReply, type WorkerRequest as ImageRequest } from "@/images/imageEngine";
import { __setInstalledFamiliesForTests } from "@/images/models";
import { dataDir } from "@/lib/paths";

const GB = 1_073_741_824;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 77]);
const PNG_B64 = Buffer.from(PNG).toString("base64");
const OTHER = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 9, 9, 9, 9]);

function pngBytes(width: number, height: number, tail = "x"): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8); head.write("IHDR", 12); head.writeUInt32BE(width, 16); head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.from(tail)]);
}

// ---- Home's key, as Home makes proofs ----
let key: { publicKey: KeyObject; privateKey: KeyObject; spki: string };
function makeKey(): typeof key {
  const pair = generateKeyPairSync("ed25519");
  return { ...pair, spki: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64") };
}
const b64url = (buffer: Buffer): string => buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
let nowMs = Date.UTC(2026, 9, 17, 12, 0, 0);
function proof(purpose: ProofPurpose, bind: string, over: { subject?: string; ttl?: number; iat?: number; signer?: KeyObject; v?: number } = {}): string {
  const iat = over.iat ?? Math.floor(nowMs / 1000);
  const payload = Buffer.from(JSON.stringify({ v: over.v ?? 1, purpose, subject: over.subject ?? "person_marlow", requester: "person_nadia", bind, iat, exp: iat + (over.ttl ?? 600), jti: crypto.randomUUID() }));
  const text = b64url(payload);
  return `${text}.${b64url(signBytes(null, Buffer.from(text), over.signer ?? key.privateKey))}`;
}

// ---- scripted workers ----
const videoRequests: VideoRequest[] = [];
const imageRequests: ImageRequest[] = [];
function scriptedVideo(onSend?: () => Promise<void> | void): VideoGenDeps {
  return {
    supported: () => true, ensureEnvironment: async () => {}, paths: () => ({ modelDir: "/models/video", tokenizerDir: "/models/tok" }),
    spawn: async (): Promise<VideoHandle> => {
      let end!: (code: number) => void;
      const exited = new Promise<number>((done) => { end = done; });
      return {
        exited, kill: () => end(143),
        send: async (request): Promise<VideoReply> => {
          videoRequests.push(request); await onSend?.();
          writeFileSync(request.output, "MP4DATA"); writeFileSync(request.poster, "JPEGDATA");
          return { id: request.id, ok: true, width: request.width, height: request.height, frames: request.num_frames, fps: 24, seed: request.seed, ms: 10, peak_bytes: 44_000_000_000 };
        },
      };
    },
  };
}
function scriptedImage(onSend?: () => Promise<void> | void): ImageGenDeps {
  return {
    supported: () => true, ensureEnvironment: async () => {}, snapshot: (family) => `/models/${family}`,
    spawn: async (): Promise<ImageHandle> => {
      let end!: (code: number) => void;
      const exited = new Promise<number>((done) => { end = done; });
      return {
        exited, kill: () => end(143), cancel: () => {},
        send: async (request): Promise<ImageReply> => {
          imageRequests.push(request); await onSend?.();
          const count = request.op === "edit" ? 1 : request.count ?? 1;
          for (let i = 0; i < count; i++) { writeFileSync(join(request.out_dir, `${i}.png`), pngBytes(request.width ?? 640, request.height ?? 480, `PIC${i}-${request.id}-${request.prompt}`)); writeFileSync(join(request.out_dir, `${i}.thumb.jpg`), "JPG"); }
          return { id: request.id, ok: true, seeds: Array.from({ length: count }, (_, i) => request.seed + i), ms: 10, peak_bytes: 13_500_000_000, width: request.width, height: request.height };
        },
      };
    },
  };
}

function clean(): void {
  videoGen.useDeps(null); imageGen.useDeps(null);
  __resetJobsForTests(); __resetGovernorForTests(); __resetProvenanceForTests(); __setInstalledFamiliesForTests(null);
  for (const path of ["video", "images", "likeness", "tmp/video", "tmp/images", "tmp/image-lora", "tmp/video-lora"]) rmSync(join(dataDir, path), { recursive: true, force: true });
}
beforeEach(() => {
  videoRequests.length = 0; imageRequests.length = 0;
  clean();
  nowMs = Date.UTC(2026, 9, 17, 12, 0, 0);
  __setLikenessClockForTests(() => nowMs);
  __resetUsedProofsForTests();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB, tier: "p128" });
  __setInstalledFamiliesForTests(["flux2-klein-4b", "z-image-turbo"]);
  registerVideoJobs(); registerImageJobs();
  key = makeKey();
  registerTrust(key.spki);
});
afterEach(() => { __setLikenessClockForTests(null); clean(); });

const postVideo = (body: Record<string, unknown>) => app.request("/v1/videos/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const postImage = (body: Record<string, unknown>) => app.request("/v1/images/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const codeOf = async (response: Response) => (await response.json() as { code?: string }).code;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// ---- the proof ----

test("a proof signed by the trusted key, for the right purpose and binding, inside its minutes, is accepted", () => {
  const payload = verifyProof(proof("photo", sha(PNG)), { purpose: "photo", bind: photoBind(PNG) });
  expect(payload).toMatchObject({ purpose: "photo", subject: "person_marlow", bind: sha(PNG) });
});

test("a proof that is forged, expired, for another picture, for another purpose, over-long or from the future is refused", () => {
  const stranger = makeKey();
  const expect403 = (token: unknown, purpose: ProofPurpose, bind: string, code: string) => {
    try { verifyProof(token, { purpose, bind }); throw new Error("accepted"); } catch (error) {
      expect(error).toBeInstanceOf(LikenessError);
      expect((error as LikenessError).code).toBe(code);
      expect((error as LikenessError).status).toBe(403);
    }
  };
  expect403(proof("photo", sha(PNG), { signer: stranger.privateKey }), "photo", sha(PNG), "likeness_proof_invalid");
  const tampered = proof("photo", sha(PNG));
  const dot = tampered.indexOf(".");
  // Flip a character in the middle of the signature (the last character holds padding bits only).
  const flipped = `${tampered.slice(0, dot + 10)}${tampered[dot + 10] === "A" ? "B" : "A"}${tampered.slice(dot + 11)}`;
  expect403(flipped, "photo", sha(PNG), "likeness_proof_invalid");
  // A changed payload with the old signature is refused too.
  expect403(`${tampered.slice(0, 12)}${tampered[12] === "A" ? "B" : "A"}${tampered.slice(13)}`, "photo", sha(PNG), "likeness_proof_invalid");
  expect403("not a proof", "photo", sha(PNG), "likeness_proof_invalid");
  expect403(undefined, "photo", sha(PNG), "likeness_proof_required");
  expect403("", "photo", sha(PNG), "likeness_proof_required");
  expect403(proof("photo", sha(OTHER)), "photo", sha(PNG), "likeness_proof_mismatch");
  expect403(proof("style_use", sha(PNG)), "photo", sha(PNG), "likeness_proof_mismatch");
  expect403(proof("photo", sha(PNG), { ttl: 31 * 60 }), "photo", sha(PNG), "likeness_proof_invalid");
  expect403(proof("photo", sha(PNG), { iat: Math.floor(nowMs / 1000) + 600 }), "photo", sha(PNG), "likeness_proof_invalid");
  expect403(proof("photo", sha(PNG), { v: 2 }), "photo", sha(PNG), "likeness_proof_invalid");
  const old = proof("photo", sha(PNG), { ttl: 60 });
  nowMs += 61_000;
  expect403(old, "photo", sha(PNG), "likeness_proof_expired");
});

test("with no trusted key every proof is refused, and a key is replaced only when the old key signs the new one", () => {
  rmSync(join(dataDir, "likeness"), { recursive: true, force: true });
  expect(() => verifyProof(proof("photo", sha(PNG)), { purpose: "photo", bind: sha(PNG) })).toThrow(/not been told which Home/);
  expect(registerTrust(key.spki)).toBe("registered");
  expect(registerTrust(key.spki)).toBe("unchanged");
  const next = makeKey();
  expect(() => registerTrust(next.spki)).toThrow(LikenessError);
  expect(() => registerTrust(next.spki, b64url(signBytes(null, Buffer.from(next.spki), makeKey().privateKey)))).toThrow(/different Home key/);
  expect(registerTrust(next.spki, signBytes(null, Buffer.from(next.spki), key.privateKey).toString("base64"))).toBe("rotated");
  expect(() => verifyProof(proof("photo", sha(PNG)), { purpose: "photo", bind: sha(PNG) })).toThrow(LikenessError);
  expect(verifyProof(proof("photo", sha(PNG), { signer: next.privateKey }), { purpose: "photo", bind: sha(PNG) }).subject).toBe("person_marlow");
  expect(() => registerTrust("AAAA")).toThrow(/Ed25519/);
});

test("the trust route registers the first key, refuses a different one and reports the state", async () => {
  rmSync(join(dataDir, "likeness"), { recursive: true, force: true });
  expect(await (await app.request("/stack/v1/likeness")).json()).toMatchObject({ likeness: { trusted: false, fingerprint: null, max_proof_minutes: 30 } });
  const put = (body: Record<string, unknown>) => app.request("/stack/v1/likeness/trust", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(await (await put({ public_key: key.spki })).json()).toMatchObject({ result: "registered" });
  const status = await (await app.request("/stack/v1/likeness")).json() as { likeness: { trusted: boolean; fingerprint: string } };
  expect(status.likeness.trusted).toBe(true);
  expect(status.likeness.fingerprint).toHaveLength(16);
  const refused = await put({ public_key: makeKey().spki });
  expect(refused.status).toBe(409);
  expect(await codeOf(refused)).toBe("likeness_key_mismatch");
  expect((await put({ public_key: "x".repeat(60) })).status).toBe(422);
});

// ---- video: the household_photo source ----

test("any picture can start a clip: uploaded, unlabelled or not from this Stack's ledger", async () => {
  videoGen.useDeps(scriptedVideo());
  expect((await postVideo({ prompt: "x", image: PNG_B64, image_source: "uploaded", timeout_ms: 5000 })).status).toBe(200);
  expect((await postVideo({ prompt: "x", image: PNG_B64, timeout_ms: 5000 })).status).toBe(200);
  expect((await postVideo({ prompt: "x", image: PNG_B64, image_source: "generated", timeout_ms: 5000 })).status).toBe(200);
});

test("a starting picture or an edit needs a declared source; a household photo needs a proof; uploaded means Home found no person", async () => {
  imageGen.useDeps(scriptedImage());
  const initB64 = pngBytes(8, 8).toString("base64");
  expect(await codeOf(await postImage({ prompt: "x", init_image: initB64 }))).toBe("reference_source_required");
  expect(await codeOf(await postImage({ prompt: "x", init_image: initB64, image_source: "generated" }))).toBe("reference_not_generated");
  expect(await codeOf(await postImage({ prompt: "x", init_image: initB64, image_source: "household_photo", audience: "adult" }))).toBe("likeness_proof_required");
  expect(await codeOf(await postImage({ prompt: "x", init_image: initB64, image_source: "household_photo", audience: "adult", consent_proof: proof("photo", sha(OTHER)) }))).toBe("likeness_proof_mismatch");
  expect(imageRequests).toHaveLength(0);
  const bytes = pngBytes(8, 8);
  expect((await postImage({ prompt: "x", init_image: initB64, image_source: "household_photo", audience: "adult", consent_proof: proof("photo", sha(bytes)), timeout_ms: 5000 })).status).toBe(200);
  expect((await postImage({ prompt: "x", init_image: initB64, image_source: "uploaded", timeout_ms: 5000 })).status).toBe(200);
  const form = (fields: Record<string, string>) => { const f = new FormData(); f.set("operation", "edit"); f.set("instruction", "make it sunny"); f.set("timeout_ms", "5000"); for (const [k, v] of Object.entries(fields)) f.set(k, v); f.set("image", new File([bytes], "in.png")); return f; };
  const edit = (fields: Record<string, string>) => app.request("/v1/images/edits", { method: "POST", body: form(fields) });
  expect(await codeOf(await edit({}))).toBe("reference_source_required");
  expect(await codeOf(await edit({ image_source: "household_photo", audience: "adult" }))).toBe("likeness_proof_required");
  expect((await edit({ image_source: "household_photo", audience: "adult", consent_proof: proof("photo", sha(bytes)) })).status).toBe(200);
});

test("a picture made from a household photo is not recorded as a free starting picture", async () => {
  imageGen.useDeps(scriptedImage());
  const bytes = pngBytes(8, 8);
  const response = await postImage({ prompt: "x", init_image: bytes.toString("base64"), image_source: "household_photo", audience: "adult", consent_proof: proof("photo", sha(bytes)), timeout_ms: 5000 });
  const body = await response.json() as { data: Array<{ b64_json: string }> };
  expect(wasGeneratedHere(new Uint8Array(Buffer.from(body.data[0]!.b64_json, "base64")))).toBe(false);
  const plain = await (await postImage({ prompt: "x", timeout_ms: 5000 })).json() as { data: Array<{ b64_json: string }> };
  expect(wasGeneratedHere(new Uint8Array(Buffer.from(plain.data[0]!.b64_json, "base64")))).toBe(true);
  // A photo someone brought (even one Home found to show no person) does not turn its output into a free starting picture either.
  const uploaded = await (await postImage({ prompt: "x", init_image: bytes.toString("base64"), image_source: "uploaded", timeout_ms: 5000 })).json() as { data: Array<{ b64_json: string }> };
  expect(wasGeneratedHere(new Uint8Array(Buffer.from(uploaded.data[0]!.b64_json, "base64")))).toBe(false);
});

test("a proof is accepted once, and a photo of a person is for an adult audience only (images)", async () => {
  imageGen.useDeps(scriptedImage());
  const bytes = pngBytes(8, 8);
  const one = proof("photo", sha(bytes));
  const send = (audience: string | null) => postImage({ prompt: "x", init_image: bytes.toString("base64"), image_source: "household_photo", consent_proof: one, ...(audience ? { audience } : {}), timeout_ms: 5000 });
  expect(await codeOf(await send(null))).toBe("likeness_adult_only");
  expect((await send("adult")).status).toBe(200);
  expect(await codeOf(await send("adult"))).toBe("likeness_proof_replayed");
  const form = new FormData();
  form.set("operation", "edit"); form.set("instruction", "x"); form.set("image_source", "household_photo"); form.set("consent_proof", proof("photo", sha(bytes))); form.set("image", new File([bytes], "in.png"));
  const noAudience = await app.request("/v1/images/edits", { method: "POST", body: form });
  expect(await codeOf(noAudience)).toBe("likeness_adult_only");
});

test("a payload that is not an object, or has odd numbers, is refused as invalid and never escapes as a 500", () => {
  const signed = (payload: string) => { const text = b64url(Buffer.from(payload)); return `${text}.${b64url(signBytes(null, Buffer.from(text), key.privateKey))}`; };
  const now = Math.floor(nowMs / 1000);
  for (const payload of ["null", "7", "[]", JSON.stringify({ v: 1, purpose: "photo", subject: "a", requester: "b", bind: sha(PNG), iat: -5, exp: 100, jti: "abcdefgh12" }), JSON.stringify({ v: 1, purpose: "photo", subject: "a", requester: "b", bind: sha(PNG), iat: now + 0.5, exp: now + 100.5, jti: "abcdefgh12" }), JSON.stringify({ v: 1, purpose: "nuke", subject: "a", requester: "b", bind: sha(PNG), iat: now, exp: now + 100, jti: "abcdefgh12" })]) {
    expect(() => verifyProof(signed(payload), { purpose: "photo", bind: sha(PNG) })).toThrow(LikenessError);
  }
});

// ---- likeness LoRAs ----

function loraFile(name: string, kind: "image" | "video", metadata?: Record<string, string>): string {
  const header: Record<string, unknown> = {};
  if (metadata) header.__metadata__ = metadata;
  for (let i = 0; i < 3; i++) {
    const prefix = kind === "image" ? `diffusion_model.double_blocks.${i}.img_attn.qkv` : `diffusion_model.blocks.${i}.self_attn.q`;
    header[`${prefix}.lora_A.weight`] = { dtype: "F16", shape: [16, 3072], data_offsets: [0, 0] };
    header[`${prefix}.lora_B.weight`] = { dtype: "F16", shape: [3072, 16], data_offsets: [0, 0] };
  }
  const json = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(json.length));
  const dir = mkdtempSync(join(tmpdir(), "likeness-lora-"));
  const path = join(dir, `${name}.safetensors`);
  writeFileSync(path, Buffer.concat([length, json, Buffer.from(name)]));
  return path;
}
const fileSha = (path: string) => createHash("sha256").update(require("node:fs").readFileSync(path)).digest("hex");

for (const kind of ["image", "video"] as const) {
  const imp = (path: string, name: string, extra: Record<string, unknown> = {}) => kind === "image"
    ? imageLoras.importFile({ path, name, licence: "apache-2.0", classification: "all-ages", ...extra })
    : importLora({ path, name, licence: "apache-2.0", classification: "all-ages", ...extra });
  const Err = kind === "image" ? LoraError : VideoLoraError;

  test(`${kind}: a style whose description names a real person is refused with no proof, and a public figure is refused even with one`, async () => {
    const path = loraFile("my-friend-portrait", kind, { ss_tags: "real person, portrait" });
    await expect(imp(path, "Friend")).rejects.toMatchObject({ code: "lora_refused" });
    const star = loraFile("a-celebrity", kind);
    await expect(imp(star, "Star", { likeness: { subject: "person_marlow", proof: proof("style_import", fileSha(star)) } })).rejects.toMatchObject({ code: "lora_refused" });
    const minor = loraFile("kid-nsfw", kind, { ss_tags: "child, nsfw, real person" });
    await expect(imp(minor, "Kid", { likeness: { subject: "person_marlow", proof: proof("style_import", fileSha(minor)) } })).rejects.toMatchObject({ code: "lora_refused" });
  });

  test(`${kind}: a style of a household adult imports with a proof, is always adult-only, and needs a proof to be used`, async () => {
    const path = loraFile("marlow-portrait", kind, { ss_tags: "real person, portrait" });
    const record = await imp(path, "Marlow portrait", { likeness: { subject: "person_marlow", proof: proof("style_import", fileSha(path)) } });
    expect(record).toMatchObject({ likeness_subject: "person_marlow", classification: "adult-only" });
    await expect((kind === "image" ? imageLoras.update(record.id, { classification: "all-ages" }) : updateLora(record.id, { classification: "all-ages" }))).rejects.toMatchObject({ code: "classification_locked" });
    const base = kind === "image" ? "flux2-klein-4b" : "wan2.2-ti2v-5b";
    const resolve = (entry: Record<string, unknown>, audience: "adult" | "all-ages" = "adult") => kind === "image" ? imageLoras.resolve([{ id: record.id, ...entry }], audience, base) : resolveLoras([{ id: record.id, ...entry } as never], audience);
    await expect(resolve({})).rejects.toMatchObject({ code: "likeness_proof_required" });
    await expect(resolve({ likenessProof: proof("style_use", record.id, { signer: makeKey().privateKey }) })).rejects.toMatchObject({ code: "likeness_proof_invalid" });
    await expect(resolve({ likenessProof: proof("style_use", "lora-0000000000000000") })).rejects.toMatchObject({ code: "likeness_proof_mismatch" });
    await expect(resolve({ likenessProof: proof("style_use", record.id, { subject: "person_other" }) })).rejects.toMatchObject({ code: "likeness_proof_mismatch" });
    await expect(resolve({ likenessProof: proof("style_use", record.id) }, "all-ages")).rejects.toMatchObject({ code: "lora_not_allowed" });
    const resolved = await resolve({ likenessProof: proof("style_use", record.id) });
    expect(resolved[0]!.likeness).toMatchObject({ purpose: "style_use", bind: record.id });
    expect(Err).toBeDefined();
  });

  test(`${kind}: an import proof for another file or purpose does not add the style`, async () => {
    const path = loraFile("marlow-two", kind, { ss_tags: "real person" });
    await expect(imp(path, "Two", { likeness: { subject: "person_marlow", proof: proof("style_import", "0".repeat(64)) } })).rejects.toMatchObject({ code: "likeness_proof_mismatch" });
    await expect(imp(path, "Two", { likeness: { subject: "person_marlow", proof: proof("photo", fileSha(path)) } })).rejects.toMatchObject({ code: "likeness_proof_mismatch" });
    await expect(imp(path, "Two", { likeness: { subject: "person_other", proof: proof("style_import", fileSha(path)) } })).rejects.toMatchObject({ code: "likeness_proof_mismatch" });
    expect(existsSync(join(dataDir, kind === "image" ? "images" : "video", "loras", "manifest.json"))).toBe(false);
  });
}

test("a picture or clip that applies a likeness style carries the proof into the job and fails it if the proof ended before it started", async () => {
  imageGen.useDeps(scriptedImage());
  const path = loraFile("marlow-img", "image", { ss_tags: "real person" });
  const record = await imageLoras.importFile({ path, name: "Marlow", licence: "apache-2.0", likeness: { subject: "person_marlow", proof: proof("style_import", fileSha(path)) } });
  const without = await postImage({ prompt: "x", audience: "adult", loras: [{ id: record.id }], timeout_ms: 5000 });
  expect(without.status).toBe(403);
  expect(await codeOf(without)).toBe("likeness_proof_required");
  const allAges = await postImage({ prompt: "x", audience: "all-ages", loras: [{ id: record.id, likeness_proof: proof("style_use", record.id) }], timeout_ms: 5000 });
  expect(await codeOf(allAges)).toBe("lora_not_allowed");
  const ok = await postImage({ prompt: "x", audience: "adult", loras: [{ id: record.id, likeness_proof: proof("style_use", record.id) }], timeout_ms: 5000 });
  expect(ok.status).toBe(200);
  expect(imageRequests).toHaveLength(1);
  const pictured = await ok.json() as { data: Array<{ b64_json: string }> };
  expect(wasGeneratedHere(new Uint8Array(Buffer.from(pictured.data[0]!.b64_json, "base64")))).toBe(false);
});

test("a likeness style whose proof ends while the picture waits in the line fails the picture when it starts", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  imageGen.useDeps(scriptedImage(async () => { if (first) { first = false; await held; } }));
  const path = loraFile("marlow-queue", "image", { ss_tags: "real person" });
  const record = await imageLoras.importFile({ path, name: "Marlow", licence: "apache-2.0", likeness: { subject: "person_marlow", proof: proof("style_import", fileSha(path)) } });
  expect((await postImage({ prompt: "a boat", timeout_ms: 1 })).status).toBe(202);
  const queued = await postImage({ prompt: "x", audience: "adult", loras: [{ id: record.id, likeness_proof: proof("style_use", record.id, { ttl: 60 }) }], timeout_ms: 1 });
  expect(queued.status).toBe(202);
  const job = (await queued.json() as { job: string }).job;
  nowMs += 120_000;
  release();
  for (let i = 0; i < 100 && getJob(job)?.state !== "failed"; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(getJob(job)?.state).toBe("failed");
  expect(imageRequests).toHaveLength(1);
});

test("the library lists the subject and the import routes need both the person and the proof", async () => {
  const path = loraFile("marlow-route", "image", { ss_tags: "real person" });
  const form = new FormData();
  form.set("path", path); form.set("name", "Marlow"); form.set("licence", "apache-2.0"); form.set("likeness_subject", "person_marlow");
  const half = await app.request("/stack/v1/image/loras", { method: "POST", body: form });
  expect(half.status).toBe(403);
  expect(await codeOf(half)).toBe("likeness_proof_required");
  form.set("likeness_proof", proof("style_import", fileSha(path)));
  const done = await app.request("/stack/v1/image/loras", { method: "POST", body: form });
  expect(done.status).toBe(200);
  expect(await done.json()).toMatchObject({ likeness_subject: "person_marlow", classification: "adult-only" });
  const list = await (await app.request("/stack/v1/image/loras")).json() as { loras: Array<{ likeness_subject: string | null }> };
  expect(list.loras[0]!.likeness_subject).toBe("person_marlow");
  const plain = loraFile("watercolor", "image");
  const plainForm = new FormData();
  plainForm.set("path", plain); plainForm.set("name", "Watercolor"); plainForm.set("licence", "apache-2.0"); plainForm.set("classification", "all-ages");
  expect(await (await app.request("/stack/v1/image/loras", { method: "POST", body: plainForm })).json()).toMatchObject({ likeness_subject: null, classification: "all-ages" });
});
