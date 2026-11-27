import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MANAGED_RUNTIMES } from "@/lib/engineCatalog";
import { STACK_MODELS, STACK_STAGED_MODELS, STACK_TTS_VOXCPM2_MODELS, STACK_TTS_VOXCPM2_STT_MODELS, VOXCPM2_ENGINE, VOXCPM2_REDUCED_ENGINE, VOXCPM2_STT_ENGINE, voxcpm2PackFor } from "@/lib/modelCatalog";
import { isVoxcpm2Engine, resolveTtsEngine, TTS_DEFAULT_BY_TIER, TTS_ENGINE_CHOICES, TTS_ENGINES } from "@/speech/ttsEngines";
import { mlxAudioCommand, MLX_AUDIO_VERSION } from "@/speech/mlxAudio";
import { voxcpm2Command, voxcpm2RequirementsFileFor, VOXCPM2_RUNTIME_NAME } from "@/speech/voxcpm2";

test("VoxCPM2 has its own runtime pin on mlx-audio 0.6.4, separate from the Chatterbox environment", () => {
  expect(MANAGED_RUNTIMES.find((runtime) => runtime.name === VOXCPM2_RUNTIME_NAME)).toMatchObject({ roles: ["tts"] });
  expect(MLX_AUDIO_VERSION).toBe("0.5.9");
  const text = readFileSync(voxcpm2RequirementsFileFor("darwin", "arm64")!, "utf8");
  expect(text).toContain("mlx-audio==0.6.4");
  expect(text).toContain("scipy==");
  expect(text).toContain("--hash=sha256:");
  expect(text).not.toMatch(/^torch==/m);
  expect(voxcpm2RequirementsFileFor("linux", "arm64")).toBeNull();
});

test("the launch command names the voxcpm2 engine and the hub-cache repo, on loopback", () => {
  const command = voxcpm2Command("/s.py", 8801, "mlx-community/VoxCPM2-4bit");
  expect(command.slice(1)).toEqual(["/s.py", "--host", "127.0.0.1", "--port", "8801", "--engine", "voxcpm2", "--repo", "mlx-community/VoxCPM2-4bit"]);
  expect(command[0]).toContain(`${VOXCPM2_RUNTIME_NAME}`);
  expect(mlxAudioCommand("/s.py", 8800, "chatterbox-turbo", "r/x")[0]).not.toBe(command[0]);
});

test("both VoxCPM2 conversions are pinned file by file: Apache-2.0, one revision each, sha256 and size, one engine name per size", () => {
  const repos = new Set(STACK_TTS_VOXCPM2_MODELS.map((pin) => pin.repo));
  expect([...repos].sort()).toEqual(["mlx-community/VoxCPM2-4bit", "mlx-community/VoxCPM2-bf16"]);
  for (const repo of repos) expect(new Set(STACK_TTS_VOXCPM2_MODELS.filter((pin) => pin.repo === repo).map((pin) => pin.revision)).size).toBe(1);
  for (const pin of STACK_TTS_VOXCPM2_MODELS) {
    expect(pin.license).toBe("Apache-2.0");
    expect(pin.engine).toBe(pin.repo!.endsWith("bf16") ? VOXCPM2_ENGINE : VOXCPM2_REDUCED_ENGINE);
    expect(pin.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.download!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pin.download!.approx_bytes).toBeGreaterThan(0);
    expect(pin.download!.url).toBe(`https://huggingface.co/${pin.repo}/resolve/${pin.revision}/${pin.download!.hub_file}`);
    expect(STACK_MODELS).toContain(pin);
    expect(STACK_STAGED_MODELS).not.toContain(pin);
  }
  // Component names are unique across the two sizes (componentModel looks a part up by name).
  const components = [...STACK_TTS_VOXCPM2_MODELS, ...STACK_TTS_VOXCPM2_STT_MODELS].flatMap((pin) => pin.component ? [pin.component] : []);
  expect(new Set(components).size).toBe(components.length);
  const bytes = (suffix: string) => STACK_TTS_VOXCPM2_MODELS.filter((pin) => pin.repo!.endsWith(suffix)).reduce((n, pin) => n + pin.download!.approx_bytes, 0);
  expect(bytes("bf16")).toBeGreaterThan(4.9e9);
  expect(bytes("4bit")).toBeGreaterThan(2.3e9);
  expect(bytes("4bit")).toBeLessThan(2.4e9);
});

test("the clip speech-to-text is pinned as a companion of both sizes: exact revision, sha256 and size per file, licence recorded", () => {
  expect(STACK_TTS_VOXCPM2_STT_MODELS.length).toBe(4);
  for (const pin of STACK_TTS_VOXCPM2_STT_MODELS) {
    expect(pin.repo).toBe("mlx-community/parakeet-tdt-0.6b-v2");
    expect(pin.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.license).toBe("CC-BY-4.0");
    expect(pin.engine).toBe(VOXCPM2_STT_ENGINE);
    expect(pin.component).toBeTruthy();
    expect(pin.download!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pin.download!.url).toBe(`https://huggingface.co/${pin.repo}/resolve/${pin.revision}/${pin.download!.hub_file}`);
    expect(STACK_MODELS).toContain(pin);
  }
  for (const engine of [VOXCPM2_ENGINE, VOXCPM2_REDUCED_ENGINE]) {
    const ids = voxcpm2PackFor(engine).map((pin) => pin.id);
    for (const pin of STACK_TTS_VOXCPM2_STT_MODELS) expect(ids).toContain(pin.id);
  }
  // The server script loads the same repository.
  expect(readFileSync(new URL("../src/speech/mlx_tts_server.py", import.meta.url), "utf8")).toContain('STT_REPO = "mlx-community/parakeet-tdt-0.6b-v2"');
});

test("Chatterbox Turbo stays the default voice on p64 and VoxCPM2 is the p128 default; below p128 VoxCPM2 is chosen only by name, in two sizes, and never by auto", () => {
  expect(TTS_DEFAULT_BY_TIER).toEqual({ p16: "pocket", p32: "pocket", p64: "chatterbox-turbo", p128: "voxcpm2" });
  expect(TTS_ENGINE_CHOICES).toEqual(expect.arrayContaining(["voxcpm2", "voxcpm2-reduced"]));
  expect(isVoxcpm2Engine("voxcpm2")).toBe(true);
  expect(isVoxcpm2Engine("voxcpm2-reduced")).toBe(true);
  expect(isVoxcpm2Engine("chatterbox-turbo")).toBe(false);
  expect(TTS_ENGINES.voxcpm2).toMatchObject({ repo: "mlx-community/VoxCPM2-bf16", runtime: "voxcpm2", catalogEngine: VOXCPM2_ENGINE });
  expect(TTS_ENGINES["voxcpm2-reduced"]).toMatchObject({ repo: "mlx-community/VoxCPM2-4bit", catalogEngine: VOXCPM2_REDUCED_ENGINE });
  for (const tier of ["p16", "p32", "p64"] as const) {
    const auto = resolveTtsEngine({ setting: "auto", tier, installed: () => true });
    expect(isVoxcpm2Engine(auto.engine)).toBe(false);
  }
  expect(resolveTtsEngine({ setting: "auto", tier: "p128", installed: () => true }).engine).toBe("voxcpm2");
});

test("a named VoxCPM2 size runs when installed and falls back to Pocket with a reason when not", () => {
  expect(resolveTtsEngine({ setting: "voxcpm2", tier: "p128", installed: () => true })).toMatchObject({ engine: "voxcpm2", reason: null });
  expect(resolveTtsEngine({ setting: "voxcpm2-reduced", tier: "p32", installed: (id) => id === "voxcpm2-reduced" })).toMatchObject({ engine: "voxcpm2-reduced" });
  const missing = resolveTtsEngine({ setting: "voxcpm2", tier: "p128", installed: () => false });
  expect(missing.engine).toBe("pocket");
  expect(missing.reason).toContain("not installed");
});
