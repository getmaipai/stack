// MODEL-SWITCH-01: Qwen3.6-35B-A3B is an optional chat model. It is pinned
// at one revision with the repository's hashes, it reads pictures through
// its own projector, no tier installs it by default, and the model Home
// chose is kept in a setting so it survives a restart.
import { afterEach, expect, test } from "bun:test";
import { buildInstallPlan } from "@/lib/installPlan";
import { type HardwareInfo } from "@/lib/hardware";
import { PROFILE_MODEL_BINDINGS } from "@/profiles";
import { STACK_CHAT_QWEN36_35B_MODEL, STACK_CHAT_QWEN36_35B_PROJECTOR, STACK_CHAT_QWEN38_UNCENSORED_MODEL, STACK_CHAT_QWEN38_UNCENSORED_PROJECTOR, STACK_MODELS } from "@/lib/modelCatalog";
import { clearModelsForTests, upsertModel } from "@/lib/modelStore";
import { resetSupervisorForTests, selectedModel } from "@/lib/supervisor";
import { __resetSettingsForTests, updateSettings } from "@/settings";
import { llamaServerArgs } from "@/lib/engineArgs";

const GB = 1_073_741_824;
const hw = (gb: number): HardwareInfo => ({ platform: "darwin", arch: "arm64", totalRamGb: gb, cpuCount: 12, isAppleSilicon: true, unifiedMemoryGb: gb, cudaDevices: [], freeDiskBytes: 500 * GB, osVersion: "test" });

afterEach(() => { clearModelsForTests(); resetSupervisorForTests(); __resetSettingsForTests(); });

test("the pin names one revision, the file's git-lfs hash and size, and its card's non-thinking sampling", () => {
  expect(STACK_MODELS).toContain(STACK_CHAT_QWEN36_35B_MODEL);
  expect(STACK_MODELS).toContain(STACK_CHAT_QWEN36_35B_PROJECTOR);
  expect(STACK_CHAT_QWEN36_35B_MODEL).toMatchObject({
    id: "qwen3-6-35b-a3b-ud-q4-k-xl", role: "chat", license: "Apache-2.0", engine: "llama-server",
    revision: "a483e9e6cbd595906af30beda3187c2663a1118c",
    download: { sha256: "707a55a8a4397ecde44de0c499d3e68c1ad1d240d1da65826b4949d1043f4450", approx_bytes: 22_360_456_160 },
    imageInput: { projector: STACK_CHAT_QWEN36_35B_PROJECTOR.id },
    sampling: { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5 },
  });
  expect(STACK_CHAT_QWEN36_35B_MODEL.download!.url).toContain("/resolve/a483e9e6cbd595906af30beda3187c2663a1118c/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf");
  expect(STACK_CHAT_QWEN36_35B_PROJECTOR).toMatchObject({ component: "projector", revision: STACK_CHAT_QWEN36_35B_MODEL.revision, download: { sha256: "8971ee4f331ff0a4c609374f32984b3d4e6dc086c0aa35f1d637fad1829e887f", approx_bytes: 899_283_680 } });
});

test("no tier installs it by default, so Muse stays the household chat model", () => {
  for (const gb of [16, 32, 64, 128]) {
    const ids = buildInstallPlan(hw(gb)).models.map((model) => model.id);
    expect(ids).not.toContain(STACK_CHAT_QWEN36_35B_MODEL.id);
    expect(ids).not.toContain(STACK_CHAT_QWEN36_35B_PROJECTOR.id);
  }
});

test("it launches with thinking off and no template variable pinned, so a request's enable_thinking turns it on for one turn", () => {
  expect(STACK_CHAT_QWEN36_35B_MODEL.launch?.chatTemplateKwargs).toBeUndefined();
  const args = llamaServerArgs({ modelPath: "/m.gguf", port: 1, config: {}, contextLength: 32768 });
  expect(args).toContain("--reasoning");
  expect(args[args.indexOf("--reasoning") + 1]).toBe("off");
  expect(args).toContain("--jinja");
  expect(args).toContain("-ngl");
});

test("the chat model Home stored in the setting is the one that runs, and a missing one falls back", () => {
  clearModelsForTests();
  const verified = { source: "catalog" as const, provenance: {}, revision: "r", sha256: "a".repeat(64), licence: "MIT", verifiedAt: new Date().toISOString(), modelPath: "/tmp/never-opened.gguf" };
  upsertModel({ id: "chat-a", roles: ["chat"], ...verified });
  upsertModel({ id: "chat-b", roles: ["chat"], ...verified });
  expect(selectedModel("chat")?.id).toBe("chat-a");
  updateSettings({ "stack.engines.chat.model": "chat-b" });
  expect(selectedModel("chat")?.id).toBe("chat-b");
  updateSettings({ "stack.engines.chat.model": "gone" });
  expect(selectedModel("chat")?.id).toBe("chat-a");
});

// Optional uncensored model (huihui-ai abliterated): pinned to its own revision, hashes and projector; never installed by default.
test("Huihui Qwen3.8 abliterated is pinned to its own revision, hashes and projector", () => {
  expect(STACK_MODELS).toContain(STACK_CHAT_QWEN38_UNCENSORED_MODEL);
  expect(STACK_MODELS).toContain(STACK_CHAT_QWEN38_UNCENSORED_PROJECTOR);
  expect(STACK_CHAT_QWEN38_UNCENSORED_MODEL).toMatchObject({
    id: "qwen3-8-27b-huihui-abliterated-iq4-xs", role: "chat", license: "Apache-2.0", engine: "llama-server",
    repo: "huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF",
    revision: "1c69098e9c32db6dc06fc48f1d6cc75ad07da89e",
    download: { sha256: "d83adbbbaace8acdfcfe28004f779326176b9df00b4ec99dc6c24d749723d3b9", approx_bytes: 14_403_496_864 },
    imageInput: { projector: STACK_CHAT_QWEN38_UNCENSORED_PROJECTOR.id },
  });
  expect(STACK_CHAT_QWEN38_UNCENSORED_MODEL.download!.url).toBe("https://huggingface.co/huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF/resolve/1c69098e9c32db6dc06fc48f1d6cc75ad07da89e/Huihui-Qwen3.8-27B-abliterated-UD-IQ4_XS.gguf");
  expect(STACK_CHAT_QWEN38_UNCENSORED_PROJECTOR).toMatchObject({
    component: "projector", revision: "1c69098e9c32db6dc06fc48f1d6cc75ad07da89e",
    download: { sha256: "c9a09064683620bea3d3bfed5d4462e1a97a7d2fff7e5045d6862a0a85eeb5b5", approx_bytes: 931_145_888 },
  });
  expect(STACK_CHAT_QWEN38_UNCENSORED_PROJECTOR.download!.url).toContain("/resolve/1c69098e9c32db6dc06fc48f1d6cc75ad07da89e/mmproj-model-bf16.gguf");
});

test("no tier installs or binds the uncensored Qwen3.8 model", () => {
  for (const gb of [16, 32, 64, 128]) {
    const ids = buildInstallPlan(hw(gb)).models.map((model) => model.id);
    expect(ids).not.toContain(STACK_CHAT_QWEN38_UNCENSORED_MODEL.id);
    expect(ids).not.toContain(STACK_CHAT_QWEN38_UNCENSORED_PROJECTOR.id);
  }
  expect(Object.values(PROFILE_MODEL_BINDINGS).flatMap((b) => Object.values(b))).not.toContain(STACK_CHAT_QWEN38_UNCENSORED_MODEL.id);
});
