import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MANAGED_RUNTIMES } from "@/lib/engineCatalog";
import { STACK_MODELS, STACK_STAGED_MODELS, STACK_TTS_VOXCPM2_MODELS, VOXCPM2_ENGINE } from "@/lib/modelCatalog";
import { TTS_DEFAULT_BY_TIER, TTS_ENGINES } from "@/speech/ttsEngines";
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

test("both VoxCPM2 conversions are pinned file by file: Apache-2.0, one revision each, sha256 and size, staged and never selected", () => {
  const repos = new Set(STACK_TTS_VOXCPM2_MODELS.map((pin) => pin.repo));
  expect([...repos].sort()).toEqual(["mlx-community/VoxCPM2-4bit", "mlx-community/VoxCPM2-bf16"]);
  for (const repo of repos) expect(new Set(STACK_TTS_VOXCPM2_MODELS.filter((pin) => pin.repo === repo).map((pin) => pin.revision)).size).toBe(1);
  for (const pin of STACK_TTS_VOXCPM2_MODELS) {
    expect(pin.license).toBe("Apache-2.0");
    expect(pin.engine).toBe(VOXCPM2_ENGINE);
    expect(pin.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.download!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pin.download!.approx_bytes).toBeGreaterThan(0);
    expect(pin.download!.url).toBe(`https://huggingface.co/${pin.repo}/resolve/${pin.revision}/${pin.download!.hub_file}`);
    expect(STACK_STAGED_MODELS).toContain(pin);
    expect(STACK_MODELS).not.toContain(pin);
  }
  const bf16 = STACK_TTS_VOXCPM2_MODELS.filter((pin) => pin.repo!.endsWith("bf16")).map((pin) => pin.download!.hub_file);
  expect(bf16).toEqual(expect.arrayContaining(["model-00001.safetensors", "model-00002.safetensors", "model.safetensors.index.json", "config.json", "tokenizer.json"]));
  const bytes = (suffix: string) => STACK_TTS_VOXCPM2_MODELS.filter((pin) => pin.repo!.endsWith(suffix)).reduce((n, pin) => n + pin.download!.approx_bytes, 0);
  expect(bytes("bf16")).toBeGreaterThan(4.9e9);
  expect(bytes("4bit")).toBeGreaterThan(2.3e9);
  expect(bytes("4bit")).toBeLessThan(2.4e9);
});

test("Chatterbox Turbo stays the default voice on its tiers and VoxCPM2 is not a selectable engine yet", () => {
  expect(TTS_DEFAULT_BY_TIER).toEqual({ p16: "pocket", p32: "pocket", p64: "chatterbox-turbo", p128: "chatterbox-turbo" });
  expect(Object.keys(TTS_ENGINES)).not.toContain("voxcpm2");
});
