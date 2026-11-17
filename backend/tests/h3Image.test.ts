// H3-IMAGE-STACK-01: the minimax-h3-image picture family. The catalog pins, the runner's command lines and its process-group kill, the
// routes (generation, edit, the steps note), the disk plan row and the tier candidates, all driven by a fake process spawner: no
// weights, no GPU, no Python. The real model is run on the Studio.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly } from "@/lib/governor";
import { __resetJobsForTests, getJob } from "@/lib/jobs";
import { H3_IMAGE_ENGINE, H3_LICENCE, H3_LICENCE_NOTICE, STACK_IMAGE_H3_ID, STACK_IMAGE_H3_MODELS, STACK_MODELS } from "@/lib/modelCatalog";
import { ENGINE_ROLE, MANAGED_RUNTIMES } from "@/lib/engineCatalog";
import { H3_IMAGE_FILES } from "@/images/pins";
import { buildH3ModelsDir, H3_LAYOUT } from "@/images/h3Layout";
import { h3RequirementsFileFor } from "@/images/h3Engine";
import { decideH3Mode, h3Command, h3EditPrompt, h3Failure, h3ModeFor, h3PeakBytes, runH3, type H3Deps, type H3Picture, type H3Run } from "@/images/h3Runner";
import { ImageError, ImageGenService, imageGen, type ImageGenDeps } from "@/images/imageEngine";
import { registerImageJobs } from "@/images/jobs";
import { readResult } from "@/images/results";
import { __setInstalledFamiliesForTests, familyInstalled, H3_MAX_PICTURES, IMAGE_FAMILIES, isFamilyId, peakBytes, referencesMaxFor, runsOnTier } from "@/images/models";
import { diskPlanForTier } from "@/lib/diskPlan";
import { componentDefs } from "@/lib/components";
import { partDef } from "@/lib/partDefs";
import { PROFILE_TIERS } from "@/profiles";
import { resolveTier, resolveLadder, tierCandidateLists, TIER_CANDIDATES } from "@/lib/tiers";
import { dataDir } from "@/lib/paths";

const GB = 1_000_000_000;
const GIB = 1_073_741_824;

function pngBytes(width: number, height: number, tail = "x"): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8); head.write("IHDR", 12); head.writeUInt32BE(width, 16); head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.from(tail)]);
}

// ---- the fake process spawner ----

interface FakeOptions { code?: number; stderr?: string; hang?: boolean; bytes?: number; deadlineMs?: number; metrics?: string }
function fakeH3(options: FakeOptions = {}) {
  const commands: string[][] = [];
  const kills: Array<{ pid: number; signal: string }> = [];
  const ends = new Map<number, (code: number) => void>();
  let nextPid = 40_000;
  const deps: H3Deps = {
    ensureEnvironment: async () => {},
    bin: () => "/engine/bin/h3-image-mlx",
    python: () => "/engine/bin/python",
    scratch: () => join(dataDir, "tmp", "h3-test"),
    spawn: (command) => {
      commands.push(command);
      const pid = nextPid++;
      let end!: (code: number) => void;
      const exited = new Promise<number>((resolve) => { end = resolve; });
      ends.set(pid, end);
      if (command[1] === "generate") {
        const flag = (name: string) => command[command.indexOf(name) + 1]!;
        if (!options.hang) setTimeout(() => {
          if (options.code && options.code !== 0) return end(options.code);
          writeFileSync(flag("--output"), pngBytes(Number(flag("--width")), Number(flag("--height")), `seed${flag("--seed")}`));
          writeFileSync(flag("--metrics"), options.metrics ?? "{}");
          end(0);
        }, 2);
      } else {
        // The finish step: [python, -I, -c, script, raw, png, thumb].
        const [, , , , raw, png, thumb] = command;
        copyFileSync(raw!, png!); writeFileSync(thumb!, "JPG");
        queueMicrotask(() => end(0));
      }
      return { pid, exited, stderr: async () => options.stderr ?? "" };
    },
    killGroup: (pid, signal) => { kills.push({ pid, signal }); ends.get(pid)?.(signal === "SIGKILL" ? 137 : 143); },
    sampleBytes: () => options.bytes ?? 19_700_000_000,
    track: () => ({ finished() {} }),
    deadlineMs: () => options.deadlineMs ?? 5_000,
    graceMs: 20,
    tickMs: 5,
  };
  return { deps, commands, kills, generated: () => commands.filter((command) => command[1] === "generate") };
}

function engineDeps(h3: H3Deps): ImageGenDeps {
  return { supported: () => true, ensureEnvironment: async () => {}, snapshot: (family) => `/models/${family}`, spawn: async () => { throw new Error("the mflux worker is not used by MiniMax H3-Image"); }, h3 };
}

function setTier(tier: "p32" | "p128", freeGb = 90): void {
  __setGovernorTuningForTestsOnly(tier === "p128" ? { totalMemoryBytes: 128 * GIB, freeMemoryBytes: freeGb * GIB, tier } : { totalMemoryBytes: 32 * GIB, freeMemoryBytes: freeGb * GIB, tier });
}
function clean(): void {
  imageGen.useDeps(null);
  __resetJobsForTests(); __resetGovernorForTests(); __setInstalledFamiliesForTests(null);
  for (const path of ["images", "tmp/images", "tmp/h3-test"]) rmSync(join(dataDir, path), { recursive: true, force: true });
}
beforeEach(() => { clean(); setTier("p128"); __setInstalledFamiliesForTests(["flux2-klein-4b", STACK_IMAGE_H3_ID]); registerImageJobs(); });
afterEach(clean);

const post = (body: Record<string, unknown>) => app.request("/v1/images/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ timeout_ms: 5000, ...body }) });
function editForm(fields: Record<string, string | File> = {}): FormData {
  const data = new FormData();
  data.set("operation", "edit"); data.set("image_source", "uploaded"); data.set("timeout_ms", "5000");
  data.set("image", new File([pngBytes(640, 480)], "in.png", { type: "image/png" }));
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}
const picture = (name: string) => new File([pngBytes(64, 64, name)], `${name}.png`, { type: "image/png" });
const edit = (data: FormData) => app.request("/v1/images/edits", { method: "POST", body: data });

// ---- (a) the catalog ----

test("(a) the catalog pins the five files of minimax-h3-image with their exact sizes, hashes and URLs", () => {
  expect(STACK_IMAGE_H3_ID).toBe("minimax-h3-image");
  const expected = [
    { id: "minimax-h3-image", bytes: 20_979_314_802, sha256: "83eb140f1ff95c068f8a6886e6d3f3d0d4ab2e07bb2fe6d2ef992a51146ee622", url: "https://huggingface.co/Comfy-Org/MiniMax-H3-Image/resolve/892de7cb61df49753bf15145a711154803a355cb/diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors", repo: "Comfy-Org/MiniMax-H3-Image", revision: "892de7cb61df49753bf15145a711154803a355cb" },
    { id: "minimax-h3-image-text-encoder", bytes: 27_141_342_152, sha256: "bc2ced0fbea64757fa9acddccfc0b3f4819d1dcf1da6c124d690d368be283923", url: "https://huggingface.co/Comfy-Org/MiniMax-H3-Image/resolve/892de7cb61df49753bf15145a711154803a355cb/text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors", repo: "Comfy-Org/MiniMax-H3-Image", revision: "892de7cb61df49753bf15145a711154803a355cb" },
    { id: "minimax-h3-image-vae", bytes: 1_168_505_312, sha256: "d80e9c2e5cfc9844869961ff5a58c9a9e52182df6bfb30b26018dd7f348721af", url: "https://huggingface.co/Comfy-Org/MiniMax-H3-Image/resolve/892de7cb61df49753bf15145a711154803a355cb/vae/minimax_h3_image_vae_fp16.safetensors", repo: "Comfy-Org/MiniMax-H3-Image", revision: "892de7cb61df49753bf15145a711154803a355cb" },
    { id: "minimax-h3-image-tokenizer", bytes: 7_032_403, sha256: "a5d85b6dcc535e6b93115a9ef287e6132fdbf30270da6218194ba742261173c7", url: "https://huggingface.co/MiniMaxAI/MiniMax-H3-Image/resolve/492fd8c4eca666f1085f57e30738c1e0d86b3439/tokenizer/tokenizer.json", repo: "MiniMaxAI/MiniMax-H3-Image", revision: "492fd8c4eca666f1085f57e30738c1e0d86b3439" },
    { id: "minimax-h3-image-vae-config", bytes: 1_826, sha256: "7fcc21bec549804ff0a04d8246e7f90e679d4f8d4b0a27a252bbd18c30e3e4bb", url: "https://huggingface.co/MiniMaxAI/MiniMax-H3-Image/resolve/492fd8c4eca666f1085f57e30738c1e0d86b3439/vae/config.json", repo: "MiniMaxAI/MiniMax-H3-Image", revision: "492fd8c4eca666f1085f57e30738c1e0d86b3439" },
  ];
  expect(STACK_IMAGE_H3_MODELS.map((pin) => ({ id: pin.id, bytes: pin.download!.approx_bytes, sha256: pin.download!.sha256, url: pin.download!.url, repo: pin.repo, revision: pin.revision }))).toEqual(expected);
  // The primary is the DiT; the other four are components of it, all under the licence and the engine.
  expect(STACK_IMAGE_H3_MODELS[0]!.component).toBeUndefined();
  expect(STACK_IMAGE_H3_MODELS.slice(1).every((pin) => pin.component?.startsWith(`${STACK_IMAGE_H3_ID}:`))).toBe(true);
  expect(STACK_IMAGE_H3_MODELS.every((pin) => pin.role === "image" && pin.license === "MiniMax-H3-Image Community License" && pin.engine === H3_IMAGE_ENGINE && !!pin.download!.hub_file)).toBe(true);
  expect(STACK_IMAGE_H3_MODELS.reduce((sum, pin) => sum + pin.download!.approx_bytes, 0)).toBe(49_296_196_495);
  expect(H3_IMAGE_FILES).toHaveLength(5);
  // Shipped with the build, ids unique, and the family reads them all.
  const ids = STACK_MODELS.map((pin) => pin.id);
  expect(STACK_IMAGE_H3_MODELS.every((pin) => ids.includes(pin.id))).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
  // The licence is carried by name with its one-line caveat, accepted before the download like every licensed model.
  expect(H3_LICENCE).toBe("MiniMax-H3-Image Community License");
  expect(H3_LICENCE_NOTICE.name).toContain("MiniMax-H3-Image Community License");
  expect(H3_LICENCE_NOTICE.summary.join(" ")).toContain("Applicable Territory");
});

test("the family: peaks, steps, edit, tiers, and no LoRA support", () => {
  const family = IMAGE_FAMILIES[STACK_IMAGE_H3_ID];
  expect(family).toMatchObject({ id: "minimax-h3-image", catalogId: "minimax-h3-image", label: "MiniMax H3-Image", licence: "MiniMax-H3-Image Community License", stepsDefault: 6, stepsMax: 6, edit: true, warmSeconds: 13, tiers: ["p16", "p32", "p64", "p128"], loraExtraBytes: 0 });
  expect(family.peak).toEqual({ gen8: 22 * GB, gen4: 22 * GB, edit: 24 * GB, stream: 2.5 * GB });
  expect(peakBytes(STACK_IMAGE_H3_ID, "generate", null, 0)).toBe(22 * GB);
  expect(peakBytes(STACK_IMAGE_H3_ID, "generate", null, 0, 1, true)).toBe(2.5 * GB);
  expect(peakBytes(STACK_IMAGE_H3_ID, "edit", null, 0)).toBe(24 * GB);
  expect(peakBytes("flux2-klein-4b", "generate", 8, 0, 1, true)).toBe(15 * GB);
  expect(isFamilyId("minimax-h3-image")).toBe(true);
  expect(runsOnTier(STACK_IMAGE_H3_ID, "p16")).toBe(true);
  expect(familyInstalled(STACK_IMAGE_H3_ID)).toBe(true);
  expect(referencesMaxFor(STACK_IMAGE_H3_ID)).toBe(H3_MAX_PICTURES - 1);
  expect(referencesMaxFor("flux2-klein-4b")).toBe(2);
});

test("the engine: h3-image-gen is a managed runtime on its own hashed requirements, and the image role's", () => {
  const runtime = MANAGED_RUNTIMES.find((entry) => entry.name === "h3-image-gen")!;
  expect(runtime).toMatchObject({ version: "0.1.0a8", roles: ["image"] });
  expect(ENGINE_ROLE["h3-image-gen"]).toBe("image");
  const requirements = readFileSync(join(import.meta.dir, "../src/images/h3-image.darwin-arm64.requirements.txt"), "utf8");
  expect(requirements).toContain("h3-image-mlx==0.1.0a8 \\");
  expect(requirements).toContain("mlx==0.32.4 \\");
  expect(requirements.split("\n").filter((line) => /^[a-z0-9_.-]+==/i.test(line)).every((line) => line.includes("\\"))).toBe(true);
  expect(requirements).toContain("--hash=sha256:");
  expect(h3RequirementsFileFor("darwin", "arm64")).toBeTruthy();
  expect(h3RequirementsFileFor("linux", "x64")).toBeNull();
  // It is a component unit of its own, with the licence to accept and its own environment.
  const unit = componentDefs().find((candidate) => candidate.id === STACK_IMAGE_H3_ID)!;
  expect(unit).toMatchObject({ label: partDef("minimax-h3-image")!.label, summary: partDef("minimax-h3-image")!.description, group: "pictures", licenceNotice: H3_LICENCE_NOTICE });
  expect(unit.usedBy()[0]).toBe("Pictures in chat and the Pictures app");
  expect(unit.envs.map((env) => env.name)).toEqual(["h3-image-gen"]);
  expect(unit.pins.map((pin) => pin.id)).toEqual(STACK_IMAGE_H3_MODELS.map((pin) => pin.id));
});

test("the engine routes know h3-image-gen: it is listed, and stop and restart have nothing to stop", async () => {
  const list = await (await app.request("/stack/v1/engines")).json() as { engines: Array<{ name: string; id: string; installed: boolean; matchesThisMachine: boolean }> };
  expect(list.engines.find((engine) => engine.name === "h3-image-gen")).toMatchObject({ id: "h3-image-gen-0.1.0a8", installed: false, matchesThisMachine: true });
  for (const action of ["stop", "restart"]) {
    const response = await app.request(`/stack/v1/engines/h3-image-gen/${action}`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  }
});

test("the runner's models folder links the five files where h3-image-mlx reads them", () => {
  const root = mkdtempSync(join(tmpdir(), "h3-layout-"));
  const files = new Map(H3_LAYOUT.map((entry, index) => { const path = join(root, `blob-${index}`); writeFileSync(path, entry.id); return [entry.id, path] as const; }));
  const dir = join(root, "models");
  expect(buildH3ModelsDir(dir, (id) => files.get(id) ?? null)).toBe(dir);
  expect(H3_LAYOUT.map((entry) => entry.layout)).toEqual(["diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors", "text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors", "vae/minimax_h3_image_vae_fp16.safetensors", "tokenizer.json", "vae/config.json"]);
  for (const entry of H3_LAYOUT) { expect(lstatSync(join(dir, entry.layout)).isSymbolicLink()).toBe(true); expect(readlinkSync(join(dir, entry.layout))).toBe(files.get(entry.id)!); }
  // One file missing: nothing is offered.
  expect(buildH3ModelsDir(join(root, "again"), (id) => (id === "minimax-h3-image-vae" ? null : files.get(id) ?? null))).toBeNull();
  expect(existsSync(join(root, "again"))).toBe(false);
  rmSync(root, { recursive: true, force: true });
});

// ---- (b) the runner ----

const base: H3Picture = { op: "generate", prompt: "a red kite", width: 1024, height: 1024, seed: 7, output: "/scratch/out.png", metrics: "/scratch/m.json", pictures: [], mode: "resident", modelsDir: "/models/minimax-h3-image" };

test("(b) the runner builds the exact command line: resident, streaming, and an edit with three references", () => {
  const bin = "/engine/bin/h3-image-mlx";
  expect(h3Command(bin, base)).toEqual([bin, "generate", "--models", "/models/minimax-h3-image", "--model", "h3", "--precision", "int8", "--dit-mode", "resident", "--seed", "7", "--width", "1024", "--height", "1024", "--prompt", "a red kite", "--output", "/scratch/out.png", "--metrics", "/scratch/m.json"]);
  expect(h3Command(bin, { ...base, mode: "stream", width: 768, height: 512 })).toEqual([bin, "generate", "--models", "/models/minimax-h3-image", "--model", "h3", "--precision", "int8", "--dit-mode", "stream", "--seed", "7", "--width", "768", "--height", "512", "--prompt", "a red kite", "--output", "/scratch/out.png", "--metrics", "/scratch/m.json"]);
  const three = h3Command(bin, { ...base, op: "edit", prompt: "Using <Picture 1>, <Picture 2> and <Picture 3>: add the dog", pictures: ["/in/a.bin", "/in/b.bin", "/in/c.bin"] });
  expect(three).toEqual([bin, "generate", "--models", "/models/minimax-h3-image", "--model", "h3", "--precision", "int8", "--dit-mode", "resident", "--seed", "7", "--width", "1024", "--height", "1024", "--prompt", "Using <Picture 1>, <Picture 2> and <Picture 3>: add the dog", "--output", "/scratch/out.png", "--metrics", "/scratch/m.json", "--reference", "/in/a.bin", "--reference", "/in/b.bin", "--reference", "/in/c.bin"]);
  // A prompt that starts with a dash stays a value; sixteen pictures are the limit.
  expect(h3Command(bin, { ...base, prompt: "- a list" })).toContain("--prompt=- a list");
  expect(() => h3Command(bin, { ...base, pictures: Array.from({ length: 17 }, (_, index) => `/in/${index}`) })).toThrow(ImageError);
  expect(h3Command(bin, { ...base, pictures: Array.from({ length: 16 }, (_, index) => `/in/${index}`) }).filter((word) => word === "--reference")).toHaveLength(16);
});

const run = (over: Partial<H3Run> = {}): H3Run => ({ op: "generate", prompt: "a kite", width: 640, height: 480, seed: 5, count: 1, pictures: [], outDir: join(dataDir, "tmp", "h3-test-out"), modelsDir: "/models/h3", mode: "resident", ...over });
afterEach(() => rmSync(join(dataDir, "tmp", "h3-test-out"), { recursive: true, force: true }));

test("(b) runH3 starts one process per picture with seed+n, finishes each, and reports the sampled tree size", async () => {
  const fake = fakeH3({ metrics: JSON.stringify({ wall_seconds: 12.5 }) });
  const result = await runH3(run({ count: 2, mode: "stream" }), { jobId: "job-1" }, fake.deps);
  expect(fake.generated().map((command) => [command[command.indexOf("--seed") + 1], command[command.indexOf("--dit-mode") + 1]])).toEqual([["5", "stream"], ["6", "stream"]]);
  expect(result).toMatchObject({ seeds: [5, 6], peakBytes: 19_700_000_000, ms: 25_000, mode: "stream" });
  for (const index of [0, 1]) { expect(existsSync(join(dataDir, "tmp", "h3-test-out", `${index}.png`))).toBe(true); expect(readFileSync(join(dataDir, "tmp", "h3-test-out", `${index}.thumb.jpg`), "utf8")).toBe("JPG"); }
  // The finish step runs under the engine's own python, isolated, on the raw file.
  const finish = fake.commands.find((command) => command[1] === "-I")!;
  expect(finish.slice(0, 3)).toEqual(["/engine/bin/python", "-I", "-c"]);
  expect(fake.kills).toEqual([]);
});

test("(b) a cancel stops the whole process group: ask, wait out the grace, then force", async () => {
  const fake = fakeH3({ hang: true });
  const controller = new AbortController();
  const running = runH3(run(), { jobId: "job-cancel", signal: controller.signal }, fake.deps);
  const outcome = running.then(() => null, (error) => error as ImageError);
  await Bun.sleep(40);
  controller.abort();
  const error = await outcome;
  expect(error).toBeInstanceOf(ImageError);
  expect(error).toMatchObject({ code: "cancelled", status: 499 });
  // The fake ends on the first signal here, so the group got SIGTERM and then the forced SIGKILL after the grace; both name the process's own group.
  expect(fake.kills.map((kill) => kill.signal)).toEqual(["SIGTERM", "SIGKILL"]);
  expect(new Set(fake.kills.map((kill) => kill.pid))).toEqual(new Set([40_000]));
});

test("(b) a picture past its deadline is stopped the same way and answers with a plain timeout", async () => {
  const fake = fakeH3({ hang: true, deadlineMs: 30 });
  const error = await runH3(run(), { jobId: "job-slow" }, fake.deps).then(() => null, (failure) => failure as ImageError);
  expect(error).toMatchObject({ code: "timeout", status: 504 });
  expect(error!.message).not.toMatch(/Traceback|\n\s+at /);
  expect(fake.kills.map((kill) => kill.signal)).toContain("SIGTERM");
});

test("(b) the mode follows the grant: resident only on 128 GB with the room, streaming otherwise, never both", () => {
  const status = (over: Record<string, unknown> = {}) => ({ tier: "p128", capBytes: 90 * GB, freeMemoryBytes: 80 * GB, marginBytes: 4 * GB, loaded: [], ...over }) as never;
  expect(h3ModeFor(status(), "generate")).toBe("resident");
  expect(h3ModeFor(status(), "edit")).toBe("resident");
  expect(h3ModeFor(status({ tier: "p64" }), "generate")).toBe("stream");
  expect(h3ModeFor(status({ tier: "p32" }), "generate")).toBe("stream");
  expect(h3ModeFor(status({ freeMemoryBytes: 20 * GB }), "generate")).toBe("stream");
  expect(h3ModeFor(status({ capBytes: 30 * GB, loaded: [{ id: "chat", peakBytes: 12 * GB }] }), "generate")).toBe("stream");
  // An idle warm picture worker is put away by the governor to make room, so it does not count against the resident peak.
  expect(h3ModeFor(status({ capBytes: 40 * GB, freeMemoryBytes: 10 * GB, loaded: [{ id: "image-pool", peakBytes: 18 * GB }, { id: "chat", peakBytes: 14 * GB }] }), "generate")).toBe("resident");
  expect(h3PeakBytes("resident", "generate")).toBe(22 * GB);
  expect(h3PeakBytes("resident", "edit")).toBe(24 * GB);
  expect(h3PeakBytes("stream", "edit")).toBe(2.5 * GB);
  expect(decideH3Mode("job-x", "generate", status({ tier: "p32" }))).toEqual({ mode: "stream", peakBytes: 2.5 * GB });
});

test("failures are plain sentences with a next step, never the process's own words", () => {
  const oom = h3Failure(137, "Traceback (most recent call last):\n  File x.py\nsecret prompt text");
  expect(oom).toMatchObject({ code: "out_of_memory", status: 507 });
  const missing = h3Failure(1, "FileNotFoundError: no such file /models/diffusion_models/x");
  expect(missing).toMatchObject({ code: "model_missing", status: 503 });
  const other = h3Failure(1, "Traceback (most recent call last):\nValueError: secret prompt text");
  expect(other).toMatchObject({ code: "failed", status: 500 });
  for (const error of [oom, missing, other]) { expect(error.message).not.toMatch(/Traceback|secret|File /); expect(error.message).toMatch(/Try again|Install it again|Close other/); }
});

// ---- (c) generation through the route ----

test("(c) a generation with model minimax-h3-image returns the fake PNG, resident on a 128 GB computer", async () => {
  const fake = fakeH3();
  imageGen.useDeps(engineDeps(fake.deps));
  const response = await post({ model: "minimax-h3-image", prompt: "a red kite over a hill", size: "1024x768", seed: 7 });
  expect(response.status).toBe(200);
  expect(response.headers.get("x-maipai-engine") ?? response.headers.get("x-maipai-model") ?? "").toBeDefined();
  const body = await response.json() as { job: string; data: Array<{ model: string; steps: number; seed: number; width: number; height: number; mode: string; b64_json: string }>; notes?: string[] };
  expect(body.notes).toBeUndefined();
  expect(body.data).toHaveLength(1);
  expect(body.data[0]).toMatchObject({ model: "minimax-h3-image", steps: 6, seed: 7, width: 1024, height: 768, mode: "generate" });
  expect(Buffer.from(body.data[0]!.b64_json, "base64").subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(Buffer.from(body.data[0]!.b64_json, "base64").toString("latin1")).toContain("seed7");
  const command = fake.generated()[0]!;
  expect(command.slice(0, 2)).toEqual(["/engine/bin/h3-image-mlx", "generate"]);
  expect(command[command.indexOf("--dit-mode") + 1]).toBe("resident");
  expect(command[command.indexOf("--prompt") + 1]).toBe("a red kite over a hill");
  expect(command).not.toContain("--reference");
  // The reported memory is the sampled size of the process tree; the job's record never holds the prompt.
  expect(readResult(body.job)).toMatchObject({ model: "minimax-h3-image", steps: 6, mlx_peak_gb: 19.7, quantize: null });
  expect(JSON.stringify(getJob(body.job))).not.toContain("red kite");
});

test("(c) n pictures are n processes with seed, seed+1, and so on", async () => {
  const fake = fakeH3();
  imageGen.useDeps(engineDeps(fake.deps));
  const response = await post({ model: "minimax-h3-image", prompt: "two", n: 3, seed: 100 });
  const body = await response.json() as { data: Array<{ seed: number }> };
  expect(body.data.map((item) => item.seed)).toEqual([100, 101, 102]);
  expect(fake.generated().map((command) => command[command.indexOf("--seed") + 1])).toEqual(["100", "101", "102"]);
});

test("(c) streaming when the computer is smaller, or when the governor cannot grant the resident room", async () => {
  for (const [tier, free] of [["p32", 20], ["p128", 26]] as const) {
    setTier(tier, free);
    const fake = fakeH3();
    imageGen.useDeps(engineDeps(fake.deps));
    expect((await post({ model: "minimax-h3-image", prompt: "stream me" })).status).toBe(200);
    expect(fake.generated().map((command) => command[command.indexOf("--dit-mode") + 1])).toEqual(["stream"]);
  }
});

test("(c) a non-zero exit is the plain failure shape: what went wrong and what to do, no stack trace", async () => {
  const fake = fakeH3({ code: 1, stderr: "Traceback (most recent call last):\n  File \"cli.py\", line 9\nValueError: a red kite over a hill" });
  imageGen.useDeps(engineDeps(fake.deps));
  const response = await post({ model: "minimax-h3-image", prompt: "a red kite over a hill" });
  expect(response.status).toBe(500);
  const body = await response.json() as { error: string; code: string };
  expect(body.code).toBe("failed");
  expect(body.error).toBe("MiniMax H3-Image could not make the picture. Try again; if it keeps failing, an admin can reinstall it from Home's Engines page.");
  expect(body.error).not.toMatch(/Traceback|red kite|File /);
  const oom = fakeH3({ code: 137 });
  imageGen.useDeps(engineDeps(oom.deps));
  const killed = await post({ model: "minimax-h3-image", prompt: "big" });
  expect(killed.status).toBe(507);
  expect(await killed.json()).toMatchObject({ code: "out_of_memory" });
});

test("(c) the family is refused in plain words when it is not installed, or on a picture to picture request", async () => {
  __setInstalledFamiliesForTests(["flux2-klein-4b"]);
  imageGen.useDeps(engineDeps(fakeH3().deps));
  const missing = await post({ model: "minimax-h3-image", prompt: "x" });
  expect(missing.status).toBe(503);
  expect(await missing.json()).toMatchObject({ code: "not_installed" });
  __setInstalledFamiliesForTests(["flux2-klein-4b", STACK_IMAGE_H3_ID]);
  const picture = await post({ model: "minimax-h3-image", prompt: "x", init_image: pngBytes(8, 8).toString("base64") });
  expect(picture.status).toBe(422);
  expect(await picture.json()).toMatchObject({ code: "unsupported_init_image" });
});

/** The mflux worker, scripted: it records which family each request named. */
function kleinWorker(h3: H3Deps): { deps: ImageGenDeps; seen: string[] } {
  const seen: string[] = [];
  const deps: ImageGenDeps = { ...engineDeps(h3), spawn: async () => ({ exited: new Promise<number>(() => {}), kill() {}, cancel() {}, send: async (request) => {
    seen.push(`${request.family}:${request.op}:${request.references?.length ?? 0}`);
    mkdirSync(request.out_dir, { recursive: true });
    writeFileSync(join(request.out_dir, "0.png"), pngBytes(640, 480)); writeFileSync(join(request.out_dir, "0.thumb.jpg"), "J");
    return { id: request.id, ok: true, seeds: [request.seed], ms: 1, peak_bytes: 1 };
  } }) };
  return { deps, seen };
}

test("the route default does not move: a request that names no model still goes to FLUX.2 Klein 4B, not the new family", async () => {
  const fake = fakeH3();
  const worker = kleinWorker(fake.deps);
  imageGen.useDeps(worker.deps);
  expect((await post({ prompt: "default" })).status).toBe(200);
  expect(worker.seen).toEqual(["flux2-klein-4b:generate:0"]);
  expect(fake.generated()).toHaveLength(0);
});

// ---- (f) steps are fixed ----

test("(f) a different steps is ignored with a note in the reply and the job status, not an error", async () => {
  const fake = fakeH3();
  imageGen.useDeps(engineDeps(fake.deps));
  const response = await post({ model: "minimax-h3-image", prompt: "steps", steps: 20 });
  expect(response.status).toBe(200);
  const body = await response.json() as { job: string; data: Array<{ steps: number }>; notes: string[] };
  expect(body.notes).toEqual(["MiniMax H3-Image always runs 6 steps, so steps: 20 was ignored."]);
  expect(body.data[0]!.steps).toBe(6);
  const status = await (await app.request(`/v1/images/generations/${body.job}`)).json() as { notes?: string[]; data: Array<{ steps: number }> };
  expect(status.notes).toEqual(body.notes);
  expect(readResult(body.job)?.notes).toEqual(body.notes);
  // The default value and an absent value say nothing.
  for (const extra of [{ steps: 6 }, {}]) {
    const quiet = await (await post({ model: "minimax-h3-image", prompt: "quiet", ...extra })).json() as { notes?: string[] };
    expect(quiet.notes).toBeUndefined();
  }
  // Another family keeps its own limit: Klein refuses more steps than it takes.
  const klein = await post({ model: "flux2-klein-4b", prompt: "too many", steps: 30 });
  expect(klein.status).toBe(422);
  expect(await klein.json()).toMatchObject({ code: "bad_steps" });
});

// ---- (g) the edit prompt wrapper, and the edit route ----

test("(g) plain edit text gets 'Using <Picture 1>: ' in front, and a text that already names a picture is left alone", () => {
  expect(h3EditPrompt("make the sky pink", 1)).toBe("Using <Picture 1>: make the sky pink");
  expect(h3EditPrompt("add the dog from the other picture", 2)).toBe("Using <Picture 1> and <Picture 2>: add the dog from the other picture");
  expect(h3EditPrompt("put the cat on the sofa", 3)).toBe("Using <Picture 1>, <Picture 2> and <Picture 3>: put the cat on the sofa");
  expect(h3EditPrompt("Using <Picture 1>: make it night. Keep everything else the same.", 1)).toBe("Using <Picture 1>: make it night. Keep everything else the same.");
  expect(h3EditPrompt("Take the hat from <Picture 2> and put it on <Picture 1>", 2)).toBe("Take the hat from <Picture 2> and put it on <Picture 1>");
  expect(h3EditPrompt("lowercase marker <picture 1> stays", 1)).toBe("lowercase marker <picture 1> stays");
  expect(h3EditPrompt("no pictures, no prefix", 0)).toBe("no pictures, no prefix");
});

test("(g) an edit with model minimax-h3-image passes every input picture, wraps the text, and sizes the picture like the input", async () => {
  const fake = fakeH3();
  imageGen.useDeps(engineDeps(fake.deps));
  const data = editForm({ model: "minimax-h3-image", instruction: "add the dog", seed: "3", reference: picture("one"), reference2: picture("two"), steps: "12" });
  const response = await edit(data);
  expect(response.status).toBe(200);
  const body = await response.json() as { job: string; data: Array<{ model: string; mode: string; steps: number; width: number; height: number }>; notes?: string[] };
  expect(body.data[0]).toMatchObject({ model: "minimax-h3-image", mode: "edit", steps: 6, width: 640, height: 480 });
  expect(body.notes).toEqual(["MiniMax H3-Image always runs 6 steps, so steps: 12 was ignored."]);
  const command = fake.generated()[0]!;
  expect(command[command.indexOf("--prompt") + 1]).toBe("Using <Picture 1>, <Picture 2> and <Picture 3>: add the dog");
  expect(command.filter((word) => word === "--reference")).toHaveLength(3);
  const references = command.flatMap((word, index) => (word === "--reference" ? [command[index + 1]!] : []));
  expect(references[0]).toMatch(/\.image\.bin$/);
  expect(references.slice(1).map((path) => path.match(/\.(ref\d)\.bin$/)?.[1])).toEqual(["ref0", "ref1"]);
  expect([command[command.indexOf("--width") + 1], command[command.indexOf("--height") + 1]]).toEqual(["640", "480"]);
  expect(command[command.indexOf("--dit-mode") + 1]).toBe("resident");
  // The input pictures are removed with the job.
  expect(references.every((path) => !existsSync(path))).toBe(true);
});

test("(g) up to sixteen input pictures: the image and fifteen references; a masked edit is refused for this model", async () => {
  const fake = fakeH3();
  imageGen.useDeps(engineDeps(fake.deps));
  const fields: Record<string, string | File> = { model: "minimax-h3-image", instruction: "<Picture 16> joins <Picture 1>", reference: picture("r1"), reference2: picture("r2") };
  for (let n = 3; n <= 15; n += 1) fields[`reference${n}`] = picture(`r${n}`);
  expect((await edit(editForm(fields))).status).toBe(200);
  const command = fake.generated()[0]!;
  expect(command.filter((word) => word === "--reference")).toHaveLength(H3_MAX_PICTURES);
  // The caller's own <Picture n> wording goes through unchanged.
  expect(command[command.indexOf("--prompt") + 1]).toBe("<Picture 16> joins <Picture 1>");
  const masked = await edit(editForm({ model: "minimax-h3-image", operation: "edit_masked", instruction: "x", region: "0.1,0.1,0.3,0.3" }));
  expect(masked.status).toBe(422);
  expect(await masked.json()).toMatchObject({ code: "unsupported_edit" });
  const unknown = await edit(editForm({ model: "no-such-model", instruction: "x" }));
  expect(unknown.status).toBe(422);
  const noEdit = await edit(editForm({ model: "z-image-turbo", instruction: "x" }));
  expect(noEdit.status).toBe(422);
  expect(await noEdit.json()).toMatchObject({ code: "unsupported_edit" });
});

test("an edit that names no model still goes to FLUX.2 Klein 4B and its two references", async () => {
  const fake = fakeH3();
  const worker = kleinWorker(fake.deps);
  imageGen.useDeps(worker.deps);
  expect((await edit(editForm({ instruction: "klein", reference: picture("a"), reference2: picture("b"), reference3: picture("c") }))).status).toBe(200);
  expect(worker.seen).toEqual(["flux2-klein-4b:edit:2"]);
  expect(fake.generated()).toHaveLength(0);
});

// ---- (d) the disk plan ----

test("(d) the disk plan lists pictures-h3 at 49.3 GB: recommended on 64 and 128 GB, optional below", () => {
  const rows = (tier: string) => diskPlanForTier(tier as never)!.rows;
  for (const tier of ["p64", "p128"]) {
    const row = rows(tier).find((candidate) => candidate.id === "pictures-h3")!;
    expect(row).toMatchObject({ label: partDef("minimax-h3-image")!.label, kind: "model", need: "recommended", selectable: true, download_bytes: 49_296_196_495, installed_bytes: 49_296_196_495, engines: ["engine:pictures-h3", "engine:python"] });
    expect(row.model_ids).toEqual(STACK_IMAGE_H3_MODELS.map((pin) => pin.id));
    expect(Math.round(row.download_bytes / 1e8) / 10).toBe(49.3);
    expect(diskPlanForTier(tier as never)!.default_selected).toContain("pictures-h3");
    expect(rows(tier).find((candidate) => candidate.id === "engine:pictures-h3")).toMatchObject({ kind: "engine", download_bytes: 80_000_000 });
  }
  // Below 64 GB the profiles offer no pictures at all (`notAvailable` has "image"), so the row is not offered there; if a profile ever turns pictures on, the row is optional below p64.
  for (const tier of ["p16", "p32"]) expect(rows(tier).find((candidate) => candidate.id === "pictures-h3")).toBeUndefined();
  expect(PROFILE_TIERS.map((tier) => tier.id)).toContain("p16");
  // The picture rows already there stay (ERNIE, Z-Image, Qwen, Klein).
  expect(rows("p128").map((row) => row.id)).toEqual(expect.arrayContaining(["pictures", "pictures-ernie", "pictures-zimage", "pictures-qwen", "pictures-h3"]));
});

// ---- (e) the tier catalog ----

test("(e) the tier candidates include the family, and recommended resolves to it for Standard and Boost on p128", () => {
  const room = 72 * GB;
  const levels = tierCandidateLists("pictures", "p128", room);
  const by = (tier: string) => levels.find((level) => level.tier === tier)!;
  expect(by("standard").recommended).toBe("minimax-h3-image");
  expect(by("boost").recommended).toBe("minimax-h3-image");
  expect(by("max").recommended).toBe("qwen-image-2512-q8");
  const row = by("standard").candidates.find((candidate) => candidate.id === "minimax-h3-image")!;
  expect(row).toMatchObject({ label: partDef("minimax-h3-image")!.label, family: "minimax-h3", peakBytes: 22 * GB, verified: true, fits: true, refusal: null });
  // ERNIE, Z-Image, Klein and Qwen-Image stay candidates.
  expect(by("standard").candidates.map((candidate) => candidate.id)).toEqual(expect.arrayContaining(["ernie-image-turbo", "flux2-klein-4b", "z-image-turbo", "qwen-image-2512-q8", "minimax-h3-image"]));
  expect(resolveTier({ category: "pictures", tier: "standard", profile: "p128", roomBytes: room })).toMatchObject({ model: "minimax-h3-image", peakBytes: 22 * GB, verified: true });
  expect(resolveTier({ category: "pictures", tier: "boost", profile: "p128", roomBytes: room })).toMatchObject({ model: "minimax-h3-image", peakBytes: 22 * GB });
  expect(resolveTier({ category: "pictures", tier: "max", profile: "p128", roomBytes: room })?.model).toBe("qwen-image-2512-q8");
  expect(resolveTier({ category: "pictures", tier: "standard", profile: "p64", roomBytes: 40 * GB })?.model).toBe("minimax-h3-image");
  // Where 22 GB does not fit the Standard cap, the older candidates still resolve.
  expect(resolveTier({ category: "pictures", tier: "standard", profile: "p64", roomBytes: 24 * GB })?.model).toBe("flux2-klein-4b");
  // The streaming Standard candidate on the small profiles.
  for (const profile of ["p16", "p32"] as const) expect(resolveTier({ category: "pictures", tier: "standard", profile, roomBytes: 12 * GB })).toMatchObject({ model: "minimax-h3-image", peakBytes: 2.5 * GB, verified: true, options: { ditMode: "stream" } });
  expect(resolveLadder("pictures", "p128", room).map((rung) => rung.resolved?.model)).toEqual(["minimax-h3-image", "minimax-h3-image", "qwen-image-2512-q8"]);
  const h3 = TIER_CANDIDATES.filter((candidate) => candidate.id === "minimax-h3-image");
  expect(h3.flatMap((candidate) => candidate.peaks.map((peak) => peak.note))).toEqual([expect.stringContaining("Studio bakeoff 2026-11-15"), expect.stringContaining("Studio bakeoff 2026-11-15")]);
  expect(h3.every((candidate) => candidate.id === STACK_IMAGE_H3_ID)).toBe(true);
});

test("the service keeps its worker out of it: an H3 picture starts no mflux worker", async () => {
  const fake = fakeH3();
  let spawnedWorkers = 0;
  const service = new ImageGenService({ ...engineDeps(fake.deps), spawn: async () => { spawnedWorkers += 1; throw new Error("no worker"); } });
  const out = join(dataDir, "tmp", "h3-service");
  const result = await service.run({ op: "generate", family: STACK_IMAGE_H3_ID, quantize: null, prompt: "p", width: 512, height: 512, steps: 6, seed: 1, count: 1, loras: [], outDir: out }, { jobId: "svc-1" });
  expect(result).toMatchObject({ seeds: [1], peakBytes: 19_700_000_000 });
  expect(spawnedWorkers).toBe(0);
  expect(service.workerAlive).toBe(false);
  rmSync(out, { recursive: true, force: true });
});
