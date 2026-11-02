// MODELS-CENSOR-05 (owner ruling, 2026-11-02): the models decide for an adult, the app only filters. The Stack has no
// likeness proof, no real-person or public-figure refusal and no photo-source refusal. These tests keep that true and keep
// the lines that stay: a minor in a sexual context is refused in every lane, an adult-only style never reaches a child's
// or teen's request, and a starting picture made from a photo someone brought is not recorded as a free starting picture.
// A scripted worker stands in for the models.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly } from "@/lib/governor";
import { __resetJobsForTests } from "@/lib/jobs";
import { registerVideoJobs } from "@/video/jobs";
import { registerImageJobs } from "@/images/jobs";
import { importLora, resolveLoras } from "@/video/loras";
import { imageLoras } from "@/images/loras";
import { __resetProvenanceForTests, wasGeneratedHere } from "@/video/provenance";
import { videoGen, type VideoGenDeps, type WorkerHandle as VideoHandle, type WorkerReply as VideoReply, type WorkerRequest as VideoRequest } from "@/video/videoGen";
import { imageGen, type ImageGenDeps, type WorkerHandle as ImageHandle, type WorkerReply as ImageReply, type WorkerRequest as ImageRequest } from "@/images/imageEngine";
import { __setInstalledFamiliesForTests } from "@/images/models";
import { dataDir } from "@/lib/paths";

const GB = 1_073_741_824;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 77]);
const PNG_B64 = Buffer.from(PNG).toString("base64");

function pngBytes(width: number, height: number, tail = "x"): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8); head.write("IHDR", 12); head.writeUInt32BE(width, 16); head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.from(tail)]);
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
  for (const path of ["video", "images", "tmp/video", "tmp/images", "tmp/image-lora", "tmp/video-lora"]) rmSync(join(dataDir, path), { recursive: true, force: true });
}
beforeEach(() => {
  videoRequests.length = 0; imageRequests.length = 0;
  clean();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB, tier: "p128" });
  __setInstalledFamiliesForTests(["flux2-klein-4b", "z-image-turbo"]);
  registerVideoJobs(); registerImageJobs();
});
afterEach(() => { clean(); });

const postVideo = (body: Record<string, unknown>) => app.request("/v1/videos/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const postImage = (body: Record<string, unknown>) => app.request("/v1/images/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const codeOf = async (response: Response) => (await response.json() as { code?: string }).code;

// ---- starting pictures: no source is refused ----

test("any picture can start a clip: uploaded, unlabelled or not from this Stack's ledger", async () => {
  videoGen.useDeps(scriptedVideo());
  expect((await postVideo({ prompt: "x", image: PNG_B64, image_source: "uploaded", timeout_ms: 5000 })).status).toBe(200);
  expect((await postVideo({ prompt: "x", image: PNG_B64, timeout_ms: 5000 })).status).toBe(200);
  expect((await postVideo({ prompt: "x", image: PNG_B64, image_source: "generated", timeout_ms: 5000 })).status).toBe(200);
});

test("a starting picture or an edit is accepted whatever its source says, or whether it says anything", async () => {
  imageGen.useDeps(scriptedImage());
  const initB64 = pngBytes(8, 8).toString("base64"), bytes = pngBytes(8, 8);
  for (const extra of [{}, { image_source: "generated" }, { image_source: "uploaded" }, { image_source: "household_photo" }, { image_source: "household_photo", audience: "adult" }]) {
    expect((await postImage({ prompt: "x", init_image: initB64, timeout_ms: 5000, ...extra })).status).toBe(200);
  }
  const form = (fields: Record<string, string>) => { const f = new FormData(); f.set("operation", "edit"); f.set("instruction", "make it sunny"); f.set("timeout_ms", "5000"); for (const [k, v] of Object.entries(fields)) f.set(k, v); f.set("image", new File([bytes], "in.png")); return f; };
  const edit = (fields: Record<string, string>) => app.request("/v1/images/edits", { method: "POST", body: form(fields) });
  for (const fields of [{} as Record<string, string>, { image_source: "generated" }, { image_source: "household_photo" }, { image_source: "household_photo", audience: "adult" }]) expect((await edit(fields)).status).toBe(200);
});

test("a picture made from a household photo is not recorded as a free starting picture", async () => {
  imageGen.useDeps(scriptedImage());
  const bytes = pngBytes(8, 8);
  const response = await postImage({ prompt: "x", init_image: bytes.toString("base64"), image_source: "household_photo", audience: "adult", timeout_ms: 5000 });
  const body = await response.json() as { data: Array<{ b64_json: string }> };
  expect(wasGeneratedHere(new Uint8Array(Buffer.from(body.data[0]!.b64_json, "base64")))).toBe(false);
  const plain = await (await postImage({ prompt: "x", timeout_ms: 5000 })).json() as { data: Array<{ b64_json: string }> };
  expect(wasGeneratedHere(new Uint8Array(Buffer.from(plain.data[0]!.b64_json, "base64")))).toBe(true);
  // A photo someone brought (even one Home found to show no person) does not turn its output into a free starting picture either.
  const uploaded = await (await postImage({ prompt: "x", init_image: bytes.toString("base64"), image_source: "uploaded", timeout_ms: 5000 })).json() as { data: Array<{ b64_json: string }> };
  expect(wasGeneratedHere(new Uint8Array(Buffer.from(uploaded.data[0]!.b64_json, "base64")))).toBe(false);
});

test("a photo of a person needs no proof and no adult audience to be edited or used as a starting picture (images)", async () => {
  imageGen.useDeps(scriptedImage());
  const bytes = pngBytes(8, 8);
  const send = (audience: string | null) => postImage({ prompt: "x", init_image: bytes.toString("base64"), image_source: "household_photo", ...(audience ? { audience } : {}), timeout_ms: 5000 });
  expect((await send(null)).status).toBe(200);
  expect((await send("adult")).status).toBe(200);
  const form = new FormData();
  form.set("operation", "edit"); form.set("instruction", "x"); form.set("image_source", "household_photo"); form.set("timeout_ms", "5000"); form.set("image", new File([bytes], "in.png"));
  expect((await app.request("/v1/images/edits", { method: "POST", body: form })).status).toBe(200);
});

// ---- LoRAs that name a real person ----

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

for (const kind of ["image", "video"] as const) {
  const imp = (path: string, name: string, extra: Record<string, unknown> = {}) => kind === "image"
    ? imageLoras.importFile({ path, name, licence: "apache-2.0", classification: "all-ages", ...extra })
    : importLora({ path, name, licence: "apache-2.0", classification: "all-ages", ...extra });
  const base = kind === "image" ? "flux2-klein-4b" : "wan2.2-ti2v-5b";
  const resolve = (id: string, audience: "adult" | "all-ages") => kind === "image" ? imageLoras.resolve([{ id }], audience, base) : resolveLoras([{ id } as never], audience, base as never);

  test(`${kind}: a style whose description names a real person, a public figure or a celebrity is added with no proof and used by an adult`, async () => {
    for (const [file, tags] of [["my-friend-portrait", "real person, portrait"], ["a-celebrity", ""], ["star-actress", "actress"], ["some-likeness", "likeness"], ["famous-streamer", "streamer, influencer"], ["the-politician", "politician"]] as const) {
      const record = await imp(loraFile(file, kind, tags ? { ss_tags: tags } : undefined), file);
      expect(record.classification).toBe("adult-only");
      expect((await resolve(record.id, "adult"))[0]!.record.id).toBe(record.id);
      await expect(resolve(record.id, "all-ages")).rejects.toMatchObject({ code: "lora_not_allowed" });
    }
  });

  test(`${kind}: a style that names a minor in a sexual context is still refused, with or without a person word`, async () => {
    for (const [file, tags] of [["kid-nsfw", "child, nsfw, real person"], ["plain-minor", "loli"], ["teen-explicit", "teen, explicit"]] as const) {
      await expect(imp(loraFile(file, kind, { ss_tags: tags }), file)).rejects.toMatchObject({ code: "lora_refused" });
    }
  });

  test(`${kind}: an ordinary style stays all-ages when asked and an unknown file stays adult-only`, async () => {
    expect(await imp(loraFile("watercolor", kind), "Watercolor")).toMatchObject({ classification: "all-ages" });
    expect(await (kind === "image" ? imageLoras.importFile({ path: loraFile("unknown", kind), name: "Unknown", licence: "apache-2.0" }) : importLora({ path: loraFile("unknown", kind), name: "Unknown", licence: "apache-2.0" }))).toMatchObject({ classification: "adult-only" });
  });
}

test("the picture library routes add a real-person style with no proof fields, and the old likeness routes and fields are gone", async () => {
  const path = loraFile("friend-route", "image", { ss_tags: "real person" });
  const form = new FormData();
  form.set("path", path); form.set("name", "Friend"); form.set("licence", "apache-2.0");
  const done = await app.request("/stack/v1/image/loras", { method: "POST", body: form });
  expect(done.status).toBe(200);
  const body = await done.json() as Record<string, unknown>;
  expect(body).toMatchObject({ classification: "adult-only" });
  expect("likeness_subject" in body).toBe(false);
  expect((await app.request("/stack/v1/likeness")).status).toBe(404);
  const videoPath = loraFile("friend-video-route", "video", { ss_tags: "celebrity" });
  const videoForm = new FormData();
  videoForm.set("path", videoPath); videoForm.set("name", "Star"); videoForm.set("licence", "apache-2.0");
  expect((await app.request("/stack/v1/video/loras", { method: "POST", body: videoForm })).status).toBe(200);
  const refused = new FormData();
  refused.set("path", loraFile("kid-route", "image", { ss_tags: "child, nsfw" })); refused.set("name", "Kid"); refused.set("licence", "apache-2.0");
  const response = await app.request("/stack/v1/image/loras", { method: "POST", body: refused });
  expect(response.status).toBe(422);
  expect(await codeOf(response)).toBe("lora_refused");
});

test("a picture or clip that applies a real-person style for an adult is made, with no proof", async () => {
  imageGen.useDeps(scriptedImage());
  videoGen.useDeps(scriptedVideo());
  const imageRecord = await imageLoras.importFile({ path: loraFile("friend-img", "image", { ss_tags: "real person" }), name: "Friend", licence: "apache-2.0" });
  expect((await postImage({ prompt: "x", audience: "adult", loras: [{ id: imageRecord.id }], timeout_ms: 5000 })).status).toBe(200);
  expect(imageRequests).toHaveLength(1);
  expect(await codeOf(await postImage({ prompt: "x", audience: "all-ages", loras: [{ id: imageRecord.id }], timeout_ms: 5000 }))).toBe("lora_not_allowed");
  const videoRecord = await importLora({ path: loraFile("friend-vid", "video", { ss_tags: "celebrity" }), name: "Star", licence: "apache-2.0" });
  expect((await postVideo({ prompt: "x", audience: "adult", loras: [{ id: videoRecord.id }], timeout_ms: 5000 })).status).toBe(200);
  expect(videoRequests).toHaveLength(1);
  expect(await codeOf(await postVideo({ prompt: "x", audience: "all-ages", loras: [{ id: videoRecord.id }], timeout_ms: 5000 }))).toBe("lora_not_allowed");
});
