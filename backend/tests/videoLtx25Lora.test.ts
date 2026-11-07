// VIDEO-LORA-05: LoRAs on the LTX-2.5 engine. Scripted worker (no weights, no GPU, no network); LoRA and pack files are tiny synthetic safetensors
// headers shaped like the real ones read on 2026-11-02 (BTS and XPLDV for LTX-2.5, googlyeyes for LTX-2.3, a kohya file): the key names, the
// widths and the 48-block layout. The worker's own Python is run with a stubbed mlx and runtime, as the Max tests do.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly } from "@/lib/governor";
import { __resetJobsForTests } from "@/lib/jobs";
import { LTX25_MAX_GEMMA_FOLDER, LTX25_MAX_REQUIRED_FILES, LTX_LICENCE, STACK_VIDEO_LTX25_MAX_MODEL_ID } from "@/lib/modelCatalog";
import { removeModel, upsertModel } from "@/lib/modelStore";
import { registerVideoJobs } from "@/video/jobs";
import { __resetProvenanceForTests } from "@/video/provenance";
import { __resetMemoryStateForTests } from "@/lib/memoryState";
import { dataDir } from "@/lib/paths";
import { loraPath } from "@/video/loras";
import { LTX25_CLIP_CAP_BYTES, LTX25_MAX_PEAK_BYTES, LTX25_LORAS_PER_CLIP, ltx25LoraAdmitBytes, ltx25LoraMode, ltx25LoraProfile, ltx25LoraWanted } from "@/video/ltx25";
import { assertLtxLoraKeys, detectLoraBase, importLora, inspectLtxLoraKeys, listLoras, LoraError, ltxLoraModule, matchLtxLoraToPack, readLoraHeader, removeLora, resolveLoras, updateLora } from "@/video/loras";
import { buildWorkerRequest, videoGen, type VideoGenDeps, type VideoRunInput, type WorkerHandle, type WorkerReply, type WorkerRequest } from "@/video/videoGen";

const GB = 1_073_741_824;
const requests: WorkerRequest[] = [];
const scratch: string[] = [];

type Tensor = { dtype: string; shape: number[] };
/** Writes a safetensors file whose header is `tensors` (zero-length data: only the header is ever read). */
function writeSafetensors(name: string, tensors: Record<string, Tensor>, metadata?: Record<string, string>): string {
  const header: Record<string, unknown> = {};
  if (metadata) header.__metadata__ = metadata;
  for (const [key, tensor] of Object.entries(tensors)) header[key] = { dtype: tensor.dtype, shape: tensor.shape, data_offsets: [0, 0] };
  const json = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(json.length));
  const dir = mkdtempSync(join(tmpdir(), "ltx25lora-")); scratch.push(dir);
  const path = join(dir, `${name}.safetensors`);
  writeFileSync(path, Buffer.concat([length, json, Buffer.from(name)]));
  return path;
}
/** The module names LTX LoRAs use, as in the real files: two blocks, video attention, an `ff` pair and an audio `to_gate_logits`. */
function comfyModules(width = 4096, rank = 16, blocks = 2): Record<string, Tensor> {
  const out: Record<string, Tensor> = {};
  const add = (module: string, inDim: number, outDim: number, style: "comfy" | "kohya" = "comfy") => {
    if (style === "comfy") {
      out[`diffusion_model.${module}.lora_A.weight`] = { dtype: "BF16", shape: [rank, inDim] };
      out[`diffusion_model.${module}.lora_B.weight`] = { dtype: "BF16", shape: [outDim, rank] };
    }
  };
  for (let i = 0; i < blocks; i++) {
    for (const part of ["to_k", "to_q", "to_v", "to_out.0"]) add(`transformer_blocks.${i}.attn1.${part}`, width, width);
    add(`transformer_blocks.${i}.ff.net.0.proj`, width, width * 4);
    add(`transformer_blocks.${i}.ff.net.2`, width * 4, width);
    add(`transformer_blocks.${i}.audio_attn1.to_gate_logits`, 2048, 32);
  }
  return out;
}
function kohyaFile(): string {
  return writeSafetensors("kohya", { "lora_unet_transformer_blocks_0_attn1_to_k.lora_down.weight": { dtype: "F16", shape: [16, 4096] }, "lora_unet_transformer_blocks_0_attn1_to_k.lora_up.weight": { dtype: "F16", shape: [4096, 16] } });
}
/** A pack transformer header (bf16, or q8 as the MrMofer pack stores it: U32 weight, bf16 scales and biases) with the same two blocks. */
function packTransformer(kind: "bf16" | "q8", width = 4096): string {
  const t: Record<string, Tensor> = { "transformer.adaln_single.linear.weight": { dtype: "BF16", shape: [36864, width] } };
  const lin = (module: string, inDim: number, outDim: number) => {
    const key = `transformer.${module}`;
    if (kind === "bf16") { t[`${key}.weight`] = { dtype: "BF16", shape: [outDim, inDim] }; return; }
    t[`${key}.weight`] = { dtype: "U32", shape: [outDim, inDim / 4] };
    t[`${key}.scales`] = { dtype: "BF16", shape: [outDim, inDim / 64] };
    t[`${key}.biases`] = { dtype: "BF16", shape: [outDim, inDim / 64] };
  };
  for (let i = 0; i < 2; i++) {
    for (const part of ["to_k", "to_q", "to_v", "to_out"]) lin(`transformer_blocks.${i}.attn1.${part}`, width, width);
    lin(`transformer_blocks.${i}.ff.proj_in`, width, width * 4);
    lin(`transformer_blocks.${i}.ff.proj_out`, width * 4, width);
    lin(`transformer_blocks.${i}.audio_attn1.to_gate_logits`, 2048, 32);
  }
  return writeSafetensors(`pack-${kind}`, t);
}

const okReply = (request: WorkerRequest): WorkerReply => ({ id: request.id, ok: true, width: request.width, height: request.height, frames: request.num_frames, fps: 24, seed: request.seed, ms: 1234, peak_bytes: 37_000_000_000, audio: true });
function scripted(): VideoGenDeps {
  return {
    supported: () => true,
    ensureEnvironment: async () => {},
    paths: (quality) => (quality === "ltx25max" ? { modelDir: "/models/max", tokenizerDir: `/models/max/${LTX25_MAX_GEMMA_FOLDER}`, textEncoderDir: `/models/max/${LTX25_MAX_GEMMA_FOLDER}` } : quality === "ltx25" ? { modelDir: "/models/ltx25", tokenizerDir: "/models/ltx25/text_encoder", textEncoderDir: "/models/ltx25/text_encoder" } : null),
    spawn: async (): Promise<WorkerHandle> => {
      let end!: (code: number) => void;
      const exited = new Promise<number>((done) => { end = done; });
      return { exited, kill: () => end(143), send: async (request) => { requests.push(request); writeFileSync(request.output, "MP4DATA-0123456789"); writeFileSync(request.poster, "JPEGDATA"); return okReply(request); } };
    },
  };
}
function clean(): void {
  videoGen.useDeps(null);
  __resetJobsForTests(); __resetGovernorForTests(); __resetProvenanceForTests(); __resetMemoryStateForTests();
  rmSync(join(dataDir, "video"), { recursive: true, force: true });
  rmSync(join(dataDir, "tmp", "video"), { recursive: true, force: true });
}
beforeEach(() => {
  requests.length = 0;
  clean();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB, tier: "p128" });
  registerVideoJobs();
});
afterEach(async () => {
  clean();
  for (const lora of listLoras()) await removeLora(lora.id);
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});
const post = (body: Record<string, unknown>) => app.request("/v1/videos/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const code = async (response: Response) => ((await response.json()) as { code?: string }).code;
const add25 = (name: string, path: string, extra: Record<string, unknown> = {}) => importLora({ path, name, licence: "apache-2.0", declaredBase: "ltx-2.5", classification: "all-ages", ...extra } as never);

// ---- the base: family from tensors, version declared ----

test("an LTX LoRA must identify itself as LTX-2.5; the retired version and undeclared files are refused", async () => {
  const path = writeSafetensors("style", comfyModules());
  const info = readLoraHeader(path);
  expect(() => detectLoraBase(info)).toThrow("That style was made for a retired video model.");
  expect(() => detectLoraBase(info, "ltx-2.3")).toThrow("That style was made for a retired video model.");
  expect(detectLoraBase(info, "ltx-2.5")).toBe("ltx-2.5");
  expect(() => detectLoraBase(info, "wan2.2-ti2v-5b")).toThrow(LoraError);
  // A trainer's own version field can only agree with the declaration.
  const named25 = readLoraHeader(writeSafetensors("n25", comfyModules(), { ss_ltx_version: "2.5.0" }));
  expect(detectLoraBase(named25)).toBe("ltx-2.5");
  expect(() => detectLoraBase(named25, "ltx-2.3")).toThrow("That style was made for a retired video model.");
  const named20 = readLoraHeader(writeSafetensors("n20", comfyModules(), { ss_ltx_version: "2.0" }));
  expect(() => detectLoraBase(named20, "ltx-2.5")).toThrow(LoraError);
  // A Wan-shaped file cannot be declared an LTX one.
  const wan = readLoraHeader(writeSafetensors("wan", { "diffusion_model.blocks.0.self_attn.q.lora_A.weight": { dtype: "F16", shape: [16, 3072] }, "diffusion_model.blocks.0.self_attn.q.lora_B.weight": { dtype: "F16", shape: [3072, 16] } }));
  expect(detectLoraBase(wan)).toBe("wan2.2-ti2v-5b");
  expect(() => detectLoraBase(wan, "ltx-2.5")).toThrow(LoraError);
  // Import records the declared base; the library lists it.
  const record = await add25("Declared", path);
  expect(record.base_model).toBe("ltx-2.5");
  expect(listLoras().map((item) => item.base_model)).toEqual(["ltx-2.5"]);
});

test("the 4 GB file cap and recognized bases are what the library reports", async () => {
  const body = await (await app.request("/stack/v1/video/loras")).json() as { base_models: string[]; max_per_clip: number };
  expect(body.base_models).toEqual(["wan2.2-ti2v-5b", "ltx-2.3", "ltx-2.5"]);
});

// ---- the keys the runtime can map ----

test("REGRESSION: a kohya file or a file with no lora_A/lora_B pair is refused with a plain code, never run as a silent no-op", async () => {
  const kohya = kohyaFile();
  const keys = inspectLtxLoraKeys(kohya);
  expect(keys).toMatchObject({ pairs: 0, kohya: 2 });
  expect(() => assertLtxLoraKeys(keys, '"Soft"')).toThrow(/kohya/);
  try { assertLtxLoraKeys(keys); } catch (error) { expect(error).toMatchObject({ code: "lora_keys_unsupported", status: 422 }); }
  const nothing = writeSafetensors("odd", { "something.weight": { dtype: "F16", shape: [4, 4] } });
  expect(inspectLtxLoraKeys(nothing)).toMatchObject({ pairs: 0, kohya: 0 });
  expect(() => assertLtxLoraKeys(inspectLtxLoraKeys(nothing))).toThrow(/no tensors/);
  // Adding an ltx-2.5 kohya file is refused at import.
  await expect(importLora({ path: kohya, name: "Soft", licence: "mit", declaredBase: "ltx-2.5" })).rejects.toMatchObject({ code: "lora_keys_unsupported" });
  // A lone lora_A with no lora_B is not a pair.
  const lone = writeSafetensors("lone", { "diffusion_model.transformer_blocks.0.attn1.to_k.lora_A.weight": { dtype: "BF16", shape: [16, 4096] } });
  expect(inspectLtxLoraKeys(lone).pairs).toBe(0);
});

test("the runtime's rename table: to_out.0, ff.net.0.proj, ff.net.2 and the diffusion_model prefix map to the transformer's own module names", () => {
  expect(ltxLoraModule("diffusion_model.transformer_blocks.3.attn2.to_out.0.lora_A.weight")).toEqual({ module: "transformer_blocks.3.attn2.to_out", side: "A" });
  expect(ltxLoraModule("diffusion_model.transformer_blocks.3.ff.net.0.proj.lora_B.weight")).toEqual({ module: "transformer_blocks.3.ff.proj_in", side: "B" });
  expect(ltxLoraModule("diffusion_model.transformer_blocks.3.audio_ff.net.2.lora_A.weight")).toEqual({ module: "transformer_blocks.3.audio_ff.proj_out", side: "A" });
  expect(ltxLoraModule("diffusion_model.transformer_blocks.0.audio_attn1.to_gate_logits.lora_A.weight")?.module).toBe("transformer_blocks.0.audio_attn1.to_gate_logits");
  expect(ltxLoraModule("lora_unet_x.lora_down.weight")).toBeNull();
});

test("matching a file against the pack: every module of a right file fits (bf16 and q8 packs); wrong names fit none; a wrong width is a shape mismatch", () => {
  const keys = inspectLtxLoraKeys(writeSafetensors("fit", comfyModules()));
  expect(keys.pairs).toBe(14);
  for (const kind of ["bf16", "q8"] as const) expect(matchLtxLoraToPack(keys, packTransformer(kind))).toEqual({ matched: 14, total: 14, shapeMismatch: 0 });
  const other = inspectLtxLoraKeys(writeSafetensors("names", { "diffusion_model.layers.0.attn.q.lora_A.weight": { dtype: "BF16", shape: [16, 4096] }, "diffusion_model.layers.0.attn.q.lora_B.weight": { dtype: "BF16", shape: [4096, 16] } }));
  expect(matchLtxLoraToPack(other, packTransformer("bf16"))).toEqual({ matched: 0, total: 1, shapeMismatch: 0 });
  // A pack of another width: the 12 big modules do not fit; the two small audio gates (2048 to 32) still do.
  expect(matchLtxLoraToPack(keys, packTransformer("bf16", 3072))).toMatchObject({ matched: 2, shapeMismatch: 12 });
  expect(matchLtxLoraToPack(keys, packTransformer("q8", 3072))).toMatchObject({ matched: 2, shapeMismatch: 12 });
});

test("resolveLoras for ltx-2.5: refuses a base mismatch, an unknown id and the adult second lock; keeps the keys it read", async () => {
  const good = await add25("Good", writeSafetensors("good", comfyModules()));
  const adult = await add25("Adult", writeSafetensors("adult", comfyModules()), { classification: "adult-only" });
  const oldPath = writeSafetensors("old", comfyModules());
  await expect(importLora({ path: oldPath, name: "Old", licence: "mit", classification: "all-ages" })).rejects.toMatchObject({ code: "wrong_base_model", message: "That style was made for a retired video model." });
  await expect(importLora({ path: oldPath, name: "Old2", licence: "mit", classification: "all-ages", declaredBase: "ltx-2.3" })).rejects.toMatchObject({ code: "wrong_base_model", message: "That style was made for a retired video model." });
  const resolved = await resolveLoras([{ id: good.id, strength: 0.8 }], "all-ages", "ltx-2.5");
  expect(resolved[0]).toMatchObject({ strength: 0.8, keys: { pairs: 14 } });
  await expect(resolveLoras([{ id: good.id }], "all-ages", "ltx-2.3")).rejects.toMatchObject({ code: "wrong_base_model" });
  await expect(resolveLoras([{ id: adult.id }], "all-ages", "ltx-2.5")).rejects.toMatchObject({ code: "lora_not_allowed" });
  expect((await resolveLoras([{ id: adult.id }], "adult", "ltx-2.5"))).toHaveLength(1);
  // The file is read again at request time: replaced by a kohya file of the same size would fail the hash; a header that lost its pairs is refused.
  await expect(updateLora(good.id, { baseModel: "wan2.2-ti2v-5b" })).rejects.toMatchObject({ code: "wrong_base_model" });
});

// ---- the admission figure and the mode per profile ----

test("modes: Max fuses; the q8 profiles prefer unfused but the pinned fork has none, so they run fused; unfused admits file bytes x 1.1, fused nothing", () => {
  expect(ltx25LoraWanted("ltx25max")).toBe("fused");
  expect(ltx25LoraWanted("ltx25")).toBe("unfused");
  expect(ltx25LoraMode("ltx25max")).toBe("fused");
  expect(ltx25LoraMode("ltx25")).toBe("fused");
  expect(ltx25LoraAdmitBytes("fused", [337_360_776, 402_758_608])).toBe(0);
  expect(ltx25LoraAdmitBytes("unfused", [337_360_776, 402_758_608])).toBe(Math.round(740_119_384 * 1.1));
  expect(ltx25LoraAdmitBytes("unfused", [])).toBe(0);
  const max = ltx25LoraProfile("ltx25max");
  expect(max).toMatchObject({ supported: true, max: LTX25_LORAS_PER_CLIP, mode: "fused", base_models: ["ltx-2.5"], reason: null });
  const standard = ltx25LoraProfile("ltx25");
  expect(standard.supported).toBe(false);
  expect(standard.max).toBe(0);
  expect(standard.reason).toContain("not been measured");
});

test("the status route reports loras and negative_prompt for Standard (not supported, why) and Max (supported, fused, base list)", async () => {
  videoGen.useDeps(scripted());
  const body = await (await app.request("/stack/v1/video")).json() as { video: { qualities: Record<string, { loras: Record<string, unknown>; negative_prompt: string }> } };
  expect(body.video.qualities.ltx25max).toMatchObject({ negative_prompt: "none", loras: { supported: true, max: 2, max_strength: 2, mode: "fused", admit_factor: 0, base_models: ["ltx-2.5"], reason: null } });
  expect(body.video.qualities.ltx25!.loras).toMatchObject({ supported: false, max: 0, mode: "fused", admit_factor: 0, base_models: ["ltx-2.5"] });
  expect(String(body.video.qualities.ltx25!.loras.reason)).toContain("Max");
});

// ---- the job API ----

test("a Max clip with a LoRA runs: the worker request carries the file and strength and the fused mode; admission adds nothing when fused", async () => {
  videoGen.useDeps(scripted());
  const record = await add25("BTS", writeSafetensors("bts", comfyModules()));
  const response = await post({ prompt: "btssetstyle, a soundstage", model: "ltx25-max", size: "1024x576", seconds: 5, loras: [{ id: record.id, strength: 0.8 }], timeout_ms: 5000 });
  expect(response.status).toBe(200);
  const entry = ((await response.json()) as { data: Array<{ lora_ids: string[] }> }).data[0]!;
  expect(entry.lora_ids).toEqual([record.id]);
  expect(requests[0]!.loras).toEqual([[expect.stringContaining(record.id), 0.8]]);
  expect(requests[0]).toMatchObject({ profile: "max", lora_mode: "fused" });
});

test("a Max clip without a LoRA sends no lora_mode; the request builder adds it only with loras", () => {
  const input: VideoRunInput = { prompt: "p", negativePrompt: null, imagePath: null, width: 1024, height: 576, frames: 241, seed: 1, loras: [], outputDir: "/tmp/x" };
  const paths = { modelDir: "/m", tokenizerDir: "/m/g", textEncoderDir: "/m/g" };
  expect(buildWorkerRequest("ltx25max", paths, input, "j", "/tmp/o.mp4", "/tmp/p.jpg").lora_mode).toBeUndefined();
  expect(buildWorkerRequest("ltx25max", paths, { ...input, loras: [["/l/a.safetensors", 1]] }, "j", "/tmp/o.mp4", "/tmp/p.jpg").lora_mode).toBe("fused");
  expect(buildWorkerRequest("ltx25", paths, { ...input, loras: [["/l/a.safetensors", 1]] }, "j", "/tmp/o.mp4", "/tmp/p.jpg").lora_mode).toBe("fused");
});

test("request validation: Standard refuses a LoRA (lora_unsupported), three is too many, a 2.3 file marked no_effect, a kohya file and an adult file on an all-ages clip are refused before a job exists", async () => {
  videoGen.useDeps(scripted());
  const good = await add25("Good", writeSafetensors("good", comfyModules()));
  const second = await add25("Second", writeSafetensors("second", comfyModules(4096, 32)));
  const third = await add25("Third", writeSafetensors("third", comfyModules(4096, 8)));
  const oldPath = writeSafetensors("old", comfyModules());
  await expect(importLora({ path: oldPath, name: "Old", licence: "mit", classification: "all-ages" })).rejects.toMatchObject({ code: "wrong_base_model" });
  const old = await importLora({ path: writeSafetensors("old-wan", { "diffusion_model.blocks.0.self_attn.q.lora_A.weight": { dtype: "F16", shape: [16, 3072] }, "diffusion_model.blocks.0.self_attn.q.lora_B.weight": { dtype: "F16", shape: [3072, 16] } }), name: "Old", licence: "mit", classification: "all-ages" });
  const legacy = { ...old, base_model: "ltx-2.3" as const, tested_on_25: "no_effect" as const };
  const manifest = JSON.parse(readFileSync(join(dataDir, "video", "loras", "manifest.json"), "utf8")) as { loras: Array<Record<string, unknown>> };
  manifest.loras[0] = legacy; writeFileSync(join(dataDir, "video", "loras", "manifest.json"), JSON.stringify(manifest, null, 1));
  const legacyBytes = await Bun.file(oldPath).arrayBuffer(); writeFileSync(loraPath(old.id), new Uint8Array(legacyBytes));
  const adult = await add25("Adult", writeSafetensors("adult", comfyModules(4096, 4)), { classification: "adult-only" });
  const base = { prompt: "x", model: "ltx25-max", size: "1024x576", seconds: 5, timeout_ms: 5000 };
  const standard = await post({ prompt: "x", model: "ltx25-q8", loras: [{ id: good.id }] });
  expect([standard.status, await code(standard)]).toEqual([422, "lora_unsupported"]);
  const many = await post({ ...base, loras: [{ id: good.id }, { id: second.id }, { id: third.id }] });
  expect([many.status, await code(many)]).toEqual([422, "too_many_loras"]);
  // LTXD-18B: a 2.3 label alone no longer refuses on 2.5; a 2.3 file the bench marked no_effect still does (the full matrix is in videoLtx23On25.test.ts).
  const wrongBase = await post({ ...base, loras: [{ id: old.id }] });
  expect([wrongBase.status, await code(wrongBase)]).toEqual([422, "lora_no_effect"]);
  const locked = await post({ ...base, loras: [{ id: adult.id }] });
  expect([locked.status, await code(locked)]).toEqual([422, "lora_not_allowed"]);
  const duplicate = await post({ ...base, loras: [{ id: good.id }, { id: good.id }] });
  expect([duplicate.status, await code(duplicate)]).toEqual([422, "duplicate_lora"]);
  const strength = await post({ ...base, loras: [{ id: good.id, strength: 3 }] });
  expect(strength.status).toBeGreaterThanOrEqual(400);
  expect(requests).toHaveLength(0);
  // An adult audience may use the adult-only file.
  expect((await post({ ...base, audience: "adult", loras: [{ id: adult.id }] })).status).toBe(200);
  expect(requests).toHaveLength(1);
});

test("a file that kept its header but lost its lora pairs after it was added is refused at request time (lora_keys_unsupported)", async () => {
  videoGen.useDeps(scripted());
  const record = await add25("Soon", writeSafetensors("soon", comfyModules()));
  // Re-write the library file as a kohya header of the same name, then fix its recorded size and time so only the key check can catch it.
  const { loraPath } = await import("@/video/loras");
  const kohya = kohyaFile();
  const bytes = await Bun.file(kohya).arrayBuffer();
  writeFileSync(loraPath(record.id), new Uint8Array(bytes));
  const refused = await post({ prompt: "x", model: "ltx25-max", size: "1024x576", seconds: 5, loras: [{ id: record.id }] });
  expect(refused.status).toBe(422);
  expect(["lora_changed", "lora_keys_unsupported"]).toContain((await code(refused)) ?? "");
});

test("with the pack installed, a LoRA none of whose layers fit the pack is refused in plain words (lora_keys_unsupported) and one of the wrong size is wrong_base_model", async () => {
  videoGen.useDeps(scripted());
  const dir = mkdtempSync(join(tmpdir(), "ltx25max-pack-")); scratch.push(dir);
  mkdirSync(join(dir, LTX25_MAX_GEMMA_FOLDER), { recursive: true });
  for (const file of LTX25_MAX_REQUIRED_FILES) { mkdirSync(join(dir, file, ".."), { recursive: true }); writeFileSync(join(dir, file), "x"); }
  const transformer = packTransformer("bf16");
  writeFileSync(join(dir, "transformer-distilled.safetensors"), await Bun.file(transformer).arrayBuffer().then((buffer) => new Uint8Array(buffer)));
  upsertModel({ id: STACK_VIDEO_LTX25_MAX_MODEL_ID, roles: ["video"], source: "catalog", provenance: { repo: "test/repo" }, revision: "rev", sha256: "a".repeat(64), licence: LTX_LICENCE, verifiedAt: new Date().toISOString(), modelPath: dir, engineRequirements: { engine: "ltx25-max-gen" } });
  try {
    const fits = await add25("Fits", writeSafetensors("fits", comfyModules()));
    const names = await add25("Names", writeSafetensors("names", { "diffusion_model.transformer_blocks.0.attn1.to_zzz.lora_A.weight": { dtype: "BF16", shape: [16, 4096] }, "diffusion_model.transformer_blocks.0.attn1.to_zzz.lora_B.weight": { dtype: "BF16", shape: [4096, 16] } }));
    const shapes = comfyModules();
    shapes["diffusion_model.transformer_blocks.0.attn1.to_k.lora_A.weight"] = { dtype: "BF16", shape: [16, 2048] };
    const wide = await add25("Wide", writeSafetensors("wide", shapes));
    const body = { prompt: "x", model: "ltx25-max", size: "1024x576", seconds: 5, timeout_ms: 5000 };
    const none = await post({ ...body, loras: [{ id: names.id }] });
    expect([none.status, await code(none)]).toEqual([422, "lora_keys_unsupported"]);
    const size = await post({ ...body, loras: [{ id: wide.id }] });
    expect([size.status, await code(size)]).toEqual([422, "wrong_base_model"]);
    expect((await post({ ...body, loras: [{ id: fits.id }] })).status).toBe(200);
    expect(requests).toHaveLength(1);
  } finally { removeModel(STACK_VIDEO_LTX25_MAX_MODEL_ID); }
});

test("the per-clip cap still holds: a figure over 64 GB with LoRA bytes is refused (lora_too_large); the Max admission figure is unchanged without LoRAs", () => {
  expect(LTX25_MAX_PEAK_BYTES).toBeLessThan(LTX25_CLIP_CAP_BYTES);
  expect(LTX25_MAX_PEAK_BYTES + ltx25LoraAdmitBytes("fused", [4 * GB])).toBe(LTX25_MAX_PEAK_BYTES);
});

// ---- the worker's own Python, with a stubbed mlx and runtime ----

const workerFile = join(import.meta.dir, "../src/video/ltx25_worker.py");
function python(script: string, ...args: string[]): { out: string[]; err: string } {
  const prelude = [
    "import sys, types, importlib.util, os, struct, json, tempfile",
    "mx = types.ModuleType('mlx.core'); mx.set_cache_limit = lambda n: None; mx.clear_cache = lambda: None",
    "pkg = types.ModuleType('mlx'); pkg.core = mx; sys.modules['mlx'] = pkg; sys.modules['mlx.core'] = mx",
    "spec = importlib.util.spec_from_file_location('w', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    "def sf(path, names):\n    h = {n: {'dtype': 'F16', 'shape': [4, 4], 'data_offsets': [0, 0]} for n in names}\n    j = json.dumps(h).encode(); open(path, 'wb').write(struct.pack('<Q', len(j)) + j)",
  ].join("\n");
  const result = Bun.spawnSync(["python3", "-I", "-c", `${prelude}\n${script}`, workerFile, ...args]);
  return { out: String(result.stdout).trim().split("\n"), err: String(result.stderr) };
}

test("worker: lora_pairs and check_loras accept ComfyUI pairs and refuse kohya, no pair, a missing file, a bad strength and a third LoRA, with the plain codes", () => {
  const dir = mkdtempSync(join(tmpdir(), "ltx25lora-py-")); scratch.push(dir);
  const run = python([
    "d = sys.argv[2]",
    "good = os.path.join(d, 'good.safetensors'); sf(good, ['diffusion_model.transformer_blocks.0.attn1.to_k.lora_A.weight', 'diffusion_model.transformer_blocks.0.attn1.to_k.lora_B.weight', 'diffusion_model.transformer_blocks.0.attn1.to_q.lora_A.weight'])",
    "kohya = os.path.join(d, 'kohya.safetensors'); sf(kohya, ['lora_unet_x.lora_down.weight', 'lora_unet_x.lora_up.weight'])",
    "none = os.path.join(d, 'none.safetensors'); sf(none, ['a.weight'])",
    "print(m.lora_pairs(good), m.lora_pairs(kohya), m.lora_pairs(none))",
    "def code(*a):\n    try: return str(m.check_loras(*a))\n    except m.LoraRefusal as e: return e.code",
    "print(code([[good, 0.8]], 'fused', 'max'))",
    "print(code([[kohya, 1]], 'fused', 'max'), code([[none, 1]], 'fused', 'max'))",
    "print(code([[os.path.join(d, 'gone.safetensors'), 1]], 'fused', 'max'), code([[good, 3]], 'fused', 'max'), code([[good, -1]], 'fused', 'max'))",
    "print(code([[good, 1], [good, 1], [good, 1]], 'fused', 'max'))",
    "print(code([[good, 1]], 'unfused', None), code([[good, 1]], 'unfused', 'max')[:2], code([[good, 1]], 'weird', 'max'), code([], 'fused', 'max'))",
    "print(m.classify(m.LoraRefusal('lora_keys_unsupported', 'plain')))",
  ].join("\n"), dir);
  expect(run.err).toBe("");
  expect(run.out[0]).toBe("(1, 0) (0, 2) (0, 0)");
  expect(run.out[1]).toContain("good.safetensors");
  expect(run.out[2]).toBe("lora_keys_unsupported lora_keys_unsupported");
  expect(run.out[3]).toBe("lora_missing bad_strength bad_strength");
  expect(run.out[4]).toBe("too_many_loras");
  expect(run.out[5]).toBe("bad_request (( bad_request ()");
  expect(run.out[6]).toBe("('lora_keys_unsupported', 'plain')");
});

test("worker: the mode goes in LTX2_LORA_MODE before the pipeline is built, _pending_loras is set, a changed set rebuilds the pipeline, and a runtime without the hook or the mode is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "ltx25lora-py-")); scratch.push(dir);
  const run = python([
    "d = sys.argv[2]",
    "good = os.path.join(d, 'good.safetensors'); sf(good, ['diffusion_model.transformer_blocks.0.attn1.to_k.lora_A.weight', 'diffusion_model.transformer_blocks.0.attn1.to_k.lora_B.weight'])",
    "other = os.path.join(d, 'other.safetensors'); sf(other, ['diffusion_model.transformer_blocks.0.attn1.to_q.lora_A.weight', 'diffusion_model.transformer_blocks.0.attn1.to_q.lora_B.weight'])",
    "built = []",
    "class Pipe:\n    def _fuse_pending_loras(self, w, l): return w\n    def __init__(self, **kw):\n        self.mode_at_build = os.environ.get('LTX2_LORA_MODE'); self.lora_mode = (self.mode_at_build or 'fused') if HAS_MODE else None\n        if not HAS_MODE: del self.lora_mode\n        built.append(self)",
    "class Old:\n    def __init__(self, **kw): built.append(self)",
    "HAS_MODE = True",
    "mod = types.ModuleType('ltx_pipelines_mlx.distilled'); mod.DistilledPipeline = Pipe; top = types.ModuleType('ltx_pipelines_mlx'); sys.modules['ltx_pipelines_mlx'] = top; sys.modules['ltx_pipelines_mlx.distilled'] = mod",
    "m._install_patches = lambda pipe: None",
    "g = None",
    "p1 = m._pipeline(d, None, 'generate', ((good, 0.8),), 'fused')",
    "print(p1.mode_at_build, p1._pending_loras)",
    "p2 = m._pipeline(d, None, 'generate', ((good, 0.8),), 'fused')",
    "print(p2 is p1)",
    "p3 = m._pipeline(d, None, 'generate', ((good, 0.8), (other, 1.0)), 'unfused')",
    "print(p3 is p1, p3.mode_at_build, p3._pending_loras == [(good, 0.8), (other, 1.0)])",
    "p4 = m._pipeline(d, None, 'generate', (), 'fused')",
    "print(p4 is p3, os.environ.get('LTX2_LORA_MODE'), hasattr(p4, '_pending_loras'))",
    "p5 = m._pipeline(d, None, 'generate', ((good, 0.5),), 'fused')",
    "print(p5._pending_loras)",
    "def refused(pipe, mode):\n    try: m.apply_loras(pipe, ((good, 1.0),), mode); return 'accepted'\n    except m.LoraRefusal as e: return e.code",
    "print(refused(Old(), 'fused'))",
    "HAS_MODE = False; fork = Pipe()",
    "print(refused(fork, 'fused'), refused(fork, 'unfused'))",
    "HAS_MODE = True; wrong = Pipe(); wrong.lora_mode = 'fused'",
    "print(refused(wrong, 'unfused'))",
  ].join("\n"), dir);
  expect(run.err).toBe("");
  expect(run.out[0]).toBe("fused [('" + join(dir, "good.safetensors") + "', 0.8)]".replace("[('", "[('"));
  expect(run.out[1]).toBe("True");
  expect(run.out[2]).toBe("False unfused True");
  expect(run.out[3]).toBe("False None False");
  expect(run.out[4]).toBe("[('" + join(dir, "good.safetensors") + "', 0.5)]");
  expect(run.out[5]).toBe("bad_request");
  expect(run.out[6]).toBe("accepted bad_request");
  expect(run.out[7]).toBe("bad_request");
});
