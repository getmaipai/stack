// LTXD-18B: a LoRA declared for LTX-2.3 on an LTX-2.5 clip is a warning, not a refusal. A bench clip (Claymation, 2026-11-06) showed one
// 2.3 file changing a 2.5 Max clip cleanly while another (googlyeyes) did nothing. The record carries the bench result as `tested_on_25`
// ("tested" | "no_effect" | null). An untested file runs with a warning and reports `untested_on_25` so Home does not offer it by default.
// Files are tiny synthetic safetensors headers (only the header is ever read); no GPU, no network.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { dataDir } from "@/lib/paths";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly } from "@/lib/governor";
import { __resetJobsForTests } from "@/lib/jobs";
import { __resetMemoryStateForTests } from "@/lib/memoryState";
import { registerVideoJobs } from "@/video/jobs";
import { __resetProvenanceForTests } from "@/video/provenance";
import { getLora, importLora, listLoras, removeLora, resolveLoras, updateLora } from "@/video/loras";
import { videoGen, type VideoGenDeps, type WorkerHandle, type WorkerReply, type WorkerRequest } from "@/video/videoGen";
import { LTX25_MAX_GEMMA_FOLDER } from "@/lib/modelCatalog";

const GB = 1_073_741_824;
const scratch: string[] = [];
const requests: WorkerRequest[] = [];

type Tensor = { dtype: string; shape: number[] };
function writeSafetensors(name: string, tensors: Record<string, Tensor>): string {
  const header: Record<string, unknown> = {};
  for (const [key, tensor] of Object.entries(tensors)) header[key] = { dtype: tensor.dtype, shape: tensor.shape, data_offsets: [0, 0] };
  const json = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(json.length));
  const dir = mkdtempSync(join(tmpdir(), "ltx23on25-")); scratch.push(dir);
  const path = join(dir, `${name}.safetensors`);
  writeFileSync(path, Buffer.concat([length, json, Buffer.from(name)]));
  return path;
}
function ltxModules(rank = 16): Record<string, Tensor> {
  const out: Record<string, Tensor> = {};
  for (const part of ["to_k", "to_q", "to_v", "to_out.0"]) {
    out[`diffusion_model.transformer_blocks.0.attn1.${part}.lora_A.weight`] = { dtype: "BF16", shape: [rank, 4096] };
    out[`diffusion_model.transformer_blocks.0.attn1.${part}.lora_B.weight`] = { dtype: "BF16", shape: [4096, rank] };
  }
  return out;
}
function wanFile(name: string): string {
  return writeSafetensors(name, { "diffusion_model.blocks.0.self_attn.q.lora_A.weight": { dtype: "F16", shape: [16, 3072] }, "diffusion_model.blocks.0.self_attn.q.lora_B.weight": { dtype: "F16", shape: [3072, 16] } });
}
/** Adds a file as LTX-2.5, then relabels the record the way an old manifest holds a 2.3 file (new 2.3 uploads stay refused). */
async function add23(name: string, rank = 16, extra: Record<string, unknown> = {}) {
  const record = await importLora({ path: writeSafetensors(name, ltxModules(rank)), name, licence: "apache-2.0", declaredBase: "ltx-2.5", classification: "all-ages", ...extra } as never);
  const file = join(dataDir, "video", "loras", "manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8")) as { loras: Array<Record<string, unknown>> };
  for (const item of manifest.loras) if (item.id === record.id) item.base_model = "ltx-2.3";
  writeFileSync(file, JSON.stringify(manifest, null, 1));
  return record;
}
const add25 = (name: string, rank = 24) => importLora({ path: writeSafetensors(name, ltxModules(rank)), name, licence: "apache-2.0", declaredBase: "ltx-2.5", classification: "all-ages" });

const okReply = (request: WorkerRequest): WorkerReply => ({ id: request.id, ok: true, width: request.width, height: request.height, frames: request.num_frames, fps: 24, seed: request.seed, ms: 1234, peak_bytes: 37_000_000_000, audio: true });
function scripted(): VideoGenDeps {
  return {
    supported: () => true,
    ensureEnvironment: async () => {},
    paths: (quality) => (quality === "ltx25max" ? { modelDir: "/models/max", tokenizerDir: `/models/max/${LTX25_MAX_GEMMA_FOLDER}`, textEncoderDir: `/models/max/${LTX25_MAX_GEMMA_FOLDER}` } : null),
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
const patch = (id: string, body: Record<string, unknown>) => app.request(`/stack/v1/video/loras/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const clip = { prompt: "x", model: "ltx25-max", size: "1024x576", seconds: 5, timeout_ms: 5000 };

test("a 2.3 file with no bench result runs on 2.5 with a warning and is reported untested_on_25", async () => {
  const record = await add23("Clay");
  expect(getLora(record.id)).toMatchObject({ base_model: "ltx-2.3", tested_on_25: null, untested_on_25: true });
  const resolved = await resolveLoras([{ id: record.id }], "all-ages", "ltx-2.5");
  expect(resolved).toHaveLength(1);
  expect(resolved[0]!.warnings).toEqual([expect.objectContaining({ id: record.id, code: "untested_on_25" })]);
  expect(resolved[0]!.warnings[0]!.message).toContain("Clay");
});

test("a 2.3 file marked tested is accepted with a warning that says it was tested, and is no longer untested_on_25", async () => {
  const record = await add23("Clay");
  const marked = await updateLora(record.id, { testedOn25: "tested" });
  expect(marked).toMatchObject({ tested_on_25: "tested", untested_on_25: false });
  expect(listLoras()[0]).toMatchObject({ tested_on_25: "tested", untested_on_25: false });
  const resolved = await resolveLoras([{ id: record.id }], "all-ages", "ltx-2.5");
  expect(resolved[0]!.warnings).toEqual([expect.objectContaining({ id: record.id, code: "tested_on_25" })]);
  // The mark can be cleared by an admin (null = not tested).
  expect(await updateLora(record.id, { testedOn25: null })).toMatchObject({ tested_on_25: null, untested_on_25: true });
});

test("a 2.3 file marked no_effect is refused on 2.5 with a plain sentence: what happened and what to do", async () => {
  const record = await add23("Googly");
  await updateLora(record.id, { testedOn25: "no_effect" });
  expect(getLora(record.id)).toMatchObject({ tested_on_25: "no_effect", untested_on_25: false });
  let caught: unknown;
  try { await resolveLoras([{ id: record.id }], "all-ages", "ltx-2.5"); } catch (error) { caught = error; }
  expect(caught).toMatchObject({ code: "lora_no_effect", status: 422 });
  const message = (caught as Error).message;
  expect(message).toContain("Googly");
  expect(message).toMatch(/changed nothing|did nothing/);
  expect(message).toMatch(/Pick|Use/);
  expect(message).not.toContain("—");
});

test("2.5 on 2.3, Wan on 2.5, 2.5 on Wan and 2.3 on Wan keep today's wrong_base_model refusal", async () => {
  const good = await add25("Good");
  const old = await add23("Old", 8);
  const wan = await importLora({ path: wanFile("wan"), name: "Wan", licence: "apache-2.0", classification: "all-ages" });
  await expect(resolveLoras([{ id: good.id }], "all-ages", "ltx-2.3")).rejects.toMatchObject({ code: "wrong_base_model" });
  await expect(resolveLoras([{ id: wan.id }], "all-ages", "ltx-2.5")).rejects.toMatchObject({ code: "wrong_base_model" });
  await expect(resolveLoras([{ id: good.id }], "all-ages", "wan2.2-ti2v-5b")).rejects.toMatchObject({ code: "wrong_base_model" });
  await expect(resolveLoras([{ id: old.id }], "all-ages", "wan2.2-ti2v-5b")).rejects.toMatchObject({ code: "wrong_base_model" });
  // A tested mark does not widen it: a tested 2.3 file is still refused on Wan.
  await updateLora(old.id, { testedOn25: "tested" });
  await expect(resolveLoras([{ id: old.id }], "all-ages", "wan2.2-ti2v-5b")).rejects.toMatchObject({ code: "wrong_base_model" });
  // A 2.5 file on a 2.5 clip carries no warning.
  expect((await resolveLoras([{ id: good.id }], "all-ages", "ltx-2.5"))[0]!.warnings).toEqual([]);
  // Wan on Wan unchanged.
  expect((await resolveLoras([{ id: wan.id }], "all-ages", "wan2.2-ti2v-5b"))[0]!.warnings).toEqual([]);
});

test("only a 2.3 record takes the mark; a bad value is refused in plain words", async () => {
  const good = await add25("Good");
  await expect(updateLora(good.id, { testedOn25: "tested" })).rejects.toMatchObject({ code: "bad_mark", status: 422 });
  const old = await add23("Old", 8);
  await expect(updateLora(old.id, { testedOn25: "maybe" as never })).rejects.toMatchObject({ code: "bad_mark", status: 422 });
  await expect(updateLora(old.id, { testedOn25: "tested" })).resolves.toMatchObject({ tested_on_25: "tested" });
  await expect(updateLora(good.id, { testedOn25: "no_effect" })).rejects.toThrow(/Only an LTX 2\.3 style/);
});

test("new 2.3 uploads and the ss_ltx_version contradiction keep today's wrong_base_model rules", async () => {
  const path = writeSafetensors("fresh", ltxModules());
  await expect(importLora({ path, name: "Fresh", licence: "mit", classification: "all-ages", declaredBase: "ltx-2.3" })).rejects.toMatchObject({ code: "wrong_base_model", message: "That style was made for a retired video model." });
});

test("the generation route accepts an untested 2.3 file with a lora_warnings entry, and refuses a no_effect file before a job exists", async () => {
  videoGen.useDeps(scripted());
  const clay = await add23("Clay");
  const googly = await add23("Googly", 8);
  const res = await post({ ...clip, loras: [{ id: clay.id }] });
  expect(res.status).toBe(200);
  const body = await res.json() as { lora_warnings?: Array<{ id: string; code: string; message: string }> };
  expect(body.lora_warnings).toEqual([expect.objectContaining({ id: clay.id, code: "untested_on_25" })]);
  expect(requests).toHaveLength(1);
  const marked = await patch(googly.id, { tested_on_25: "no_effect" });
  expect(marked.status).toBe(200);
  expect(await marked.json()).toMatchObject({ tested_on_25: "no_effect", untested_on_25: false });
  const refused = await post({ ...clip, loras: [{ id: googly.id }] });
  expect(refused.status).toBe(422);
  expect(((await refused.json()) as { code?: string }).code).toBe("lora_no_effect");
  expect(requests).toHaveLength(1);
  const list = await (await app.request("/stack/v1/video/loras")).json() as { loras: Array<{ id: string; tested_on_25: string | null; untested_on_25: boolean }> };
  expect(list.loras.find((item) => item.id === clay.id)).toMatchObject({ tested_on_25: null, untested_on_25: true });
  expect(list.loras.find((item) => item.id === googly.id)).toMatchObject({ tested_on_25: "no_effect", untested_on_25: false });
});
