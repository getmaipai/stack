// STACK-94c: the tts role. The speech form route streams the engine's
// WAV with identity headers and passes a bad voice through, a client
// abort is a normal end that releases the process, the readiness check
// renders the probe sentence, the token setting is encrypted at rest and
// redacted on the route, the uv pins select by name, the environment
// builder refuses a platform without a requirements file, hub files
// land in the hub cache once, and the loaded weights are read from it.
// Nothing here runs uv or Pocket TTS.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { engineRole, installedEnginePin, selectEngineBinary } from "@/lib/engineCatalog";
import { engineBinaryPath } from "@/lib/engineInstall";
import { __resetHealthForTests } from "@/lib/health";
import { clearModelsForTests, installCatalogModel, upsertModel } from "@/lib/modelStore";
import { modelsDir } from "@/lib/paths";
import { readHfFile } from "@/lib/store/hfCache";
import { hfHubRoot } from "@/lib/store/layout";
import { runCheck } from "@/lib/readiness";
import { componentModel, getRoleStatus, PROBE_SENTENCE, resetSupervisorForTests, scriptedProcess, selectedModel, setSupervisorFactoryForTests, speakRole, speechForm } from "@/lib/supervisor";
import { ensurePocketTtsEnvironment, loadedWeightsRepo, pocketTtsCommand, pocketTtsEnv, POCKET_TTS_GATED_REPO, POCKET_TTS_UNGATED_REPO, requirementsFileFor } from "@/speech/pocketTts";
import { __resetSettingsForTests, readSettings, SECRET_SET, settingValues, updateSettings, applyPendingSettings } from "@/settings";

beforeEach(() => { __resetHealthForTests(); __resetSettingsForTests(); clearModelsForTests(); setSupervisorFactoryForTests(async (role) => scriptedProcess(role)); });
afterEach(() => { setSupervisorFactoryForTests(null); resetSupervisorForTests(); clearModelsForTests(); __resetSettingsForTests(); });

function speak(fields: Record<string, string>, init: RequestInit = {}): Promise<Response> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return Promise.resolve(app.request("/v1/audio/speech", { method: "POST", body: form, ...init }));
}

test("POST /v1/audio/speech takes the spec's form and streams the engine's WAV with the identity headers, header first", async () => {
  const response = await speak({ text: PROBE_SENTENCE });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("audio/wav");
  expect(response.headers.get("x-maipai-engine")).toBe("stub scripted");
  expect(response.headers.get("x-maipai-model")).toBe("scripted-tts");
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("RIFF");
  expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(24_000);
  // The placeholder data size the spec's consumer tolerates, then the audio.
  expect(new DataView(bytes.buffer).getUint32(40, true)).toBe(2_000_000_000);
  expect(bytes.byteLength).toBe(44 + 4_800);
});

test("a voice the engine does not have is the engine's own 400, passed through; an empty text is refused before the engine", async () => {
  const bad = await speak({ text: "hello", voice_url: "nobody" });
  expect(bad.status).toBe(400);
  expect(await bad.json()).toEqual({ detail: "Unknown voice nobody." });
  expect((await speak({ text: "" })).status).toBe(400);
  expect((await speak({ text: "hello", model: "chat" })).status).toBe(400);
});

test("a client abort mid-stream is a normal end: the process is released and answers the next request", async () => {
  const controller = new AbortController();
  const spoken = await speakRole("tts", speechForm("a long sentence"), controller.signal);
  expect(spoken.status).toBe(200);
  const reader = spoken.body!.getReader();
  await reader.read();
  controller.abort();
  await reader.cancel().catch(() => {});
  expect(getRoleStatus("tts").state).toBe("ready");
  const again = await speak({ text: "again" });
  expect(again.status).toBe(200);
  await again.arrayBuffer();
});

test("the readiness check renders the probe sentence through the speech wire and counts tts, never skips it", async () => {
  const run = await runCheck({ roleIds: ["tts"] });
  expect(run.ok).toBe(true);
  expect(run.results).toEqual([expect.objectContaining({ role: "tts", ok: true })]);
});

test("the Hugging Face token is stored encrypted, applied on restart, revealed only to the launch code and redacted on the route", async () => {
  updateSettings({ "stack.engines.tts.hf_token": "hf_examplesecret" });
  const pending = readSettings().find((setting) => setting.key === "stack.engines.tts.hf_token")!;
  expect(pending.pending).toBe(SECRET_SET);
  expect(pending.in_effect).toBe("");
  applyPendingSettings();
  expect(settingValues()["stack.engines.tts.hf_token"]).toBe("hf_examplesecret");
  const served = await (await app.request("/stack/v1/settings")).json() as { settings: Array<{ key: string; in_effect: unknown; secret?: boolean }> };
  const row = served.settings.find((setting) => setting.key === "stack.engines.tts.hf_token")!;
  expect(row.secret).toBe(true);
  expect(row.in_effect).toBe(SECRET_SET);
  expect(JSON.stringify(served)).not.toContain("hf_examplesecret");
  // The environment carries it as HF_TOKEN and every cache under data/.
  const env = pocketTtsEnv({ HF_TOKEN: settingValues()["stack.engines.tts.hf_token"] as string });
  expect(env.HF_TOKEN).toBe("hf_examplesecret");
  expect(env.HOME).toContain("/home");
  expect(env.UV_CACHE_DIR).toContain("/engines/uv/cache");
  expect(env.HF_HUB_CACHE).toBe(hfHubRoot);
});

test("the uv pins select by name and never as llama-server; the tool path is uv", () => {
  const hardware = { platform: "darwin", arch: "arm64", cudaDevices: [] } as never;
  expect(selectEngineBinary(hardware)?.name).toBe("llama-server");
  expect(selectEngineBinary(hardware, "uv")?.id).toBe("uv-0.12.17-macos-arm64");
  expect(selectEngineBinary({ platform: "linux", arch: "arm64", cudaDevices: [] } as never, "uv")?.id).toBe("uv-0.12.17-linux-arm64");
  expect(selectEngineBinary({ platform: "linux", arch: "arm64", cudaDevices: [] } as never)).toBeNull();
  const uv = installedEnginePin("uv");
  expect(uv?.tool).toBe("uv");
  expect(engineBinaryPath(uv!)).toMatch(/\/engines\/uv\/0\.12\.17\/uv$/);
  expect(engineRole("uv")).toBe("tts");
  expect(engineRole("pocket-tts")).toBe("tts");
  expect(engineRole("llama-server")).toBe("chat");
  expect(pocketTtsCommand(8795).slice(1)).toEqual(["serve", "--host", "127.0.0.1", "--port", "8795"]);
});

test("a platform without a hashed requirements file cannot build the environment and says so", async () => {
  expect(requirementsFileFor("darwin", "arm64")).toMatch(/pocket-tts\.darwin-arm64\.requirements\.txt$/);
  expect(readFileSync(requirementsFileFor("darwin", "arm64")!, "utf8")).toContain("pocket-tts==3.1.0");
  expect(requirementsFileFor("linux", "arm64")).toBeNull();
  if (process.platform !== "darwin" || process.arch !== "arm64") await expect(ensurePocketTtsEnvironment()).rejects.toThrow(/No hashed requirements file/);
});

test("a hub file installs into the hub cache once, at the pinned repository and revision, and a second install fetches nothing", async () => {
  const bytes = Buffer.from("weights".repeat(1000));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let downloads = 0;
  const pin = { id: "tts-weights-test", role: "tts" as const, repo: "kyutai/pocket-tts-without-voice-cloning", license: "CC-BY-4.0", revision: "d29db7978e464fb90cb3359ee0c69a273b9142cc", engine: "pocket-tts", download: { url: "https://huggingface.co/x/model.safetensors", sha256, approx_bytes: bytes.length, hub_file: "languages/english/model.safetensors" } };
  const install = () => installCatalogModel(pin, { destination: join(modelsDir, pin.id, "model.safetensors"), download: async (_url, destination) => { downloads += 1; mkdirSync(join(destination, ".."), { recursive: true }); writeFileSync(destination, bytes); } });
  const installed = await install();
  expect(installed.modelPath).toBe(join(hfHubRoot, "models--kyutai--pocket-tts-without-voice-cloning", "snapshots", pin.revision, "languages", "english", "model.safetensors"));
  expect(lstatSync(installed.modelPath!).isSymbolicLink()).toBe(true);
  expect(readHfFile(pin.repo, pin.revision, pin.download.hub_file)?.digest).toBe(sha256);
  // Moved, not copied: the download is held once.
  expect(existsSync(join(modelsDir, pin.id, "model.safetensors"))).toBe(false);
  await install();
  expect(downloads).toBe(1);
  expect(selectedModel("tts")?.id).toBe(pin.id);
  expect(loadedWeightsRepo({ tokenSet: false })).toEqual({ repo: POCKET_TTS_UNGATED_REPO, revision: pin.revision });
});

test("the loaded weights are whichever repository the hub cache holds, gated first when a token is set", () => {
  const hub = join(tmpdir(), `maipai-stack-hub-${Date.now()}`);
  const snapshot = (repo: string, revision: string) => { const dir = join(hub, `models--${repo.replaceAll("/", "--")}`, "snapshots", revision, "languages", "english"); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "model.safetensors"), "w"); };
  expect(loadedWeightsRepo({ tokenSet: false, hubRoot: hub })).toBeNull();
  snapshot(POCKET_TTS_UNGATED_REPO, "d29db797");
  expect(loadedWeightsRepo({ tokenSet: true, hubRoot: hub })).toEqual({ repo: POCKET_TTS_UNGATED_REPO, revision: "d29db797" });
  snapshot(POCKET_TTS_GATED_REPO, "39592ff2");
  expect(loadedWeightsRepo({ tokenSet: true, hubRoot: hub })?.repo).toBe(POCKET_TTS_GATED_REPO);
  expect(loadedWeightsRepo({ tokenSet: false, hubRoot: hub })?.repo).toBe(POCKET_TTS_UNGATED_REPO);
  rmSync(hub, { recursive: true, force: true });
});

test("the tokenizer and the voice are components of tts, installed beside the weights and never selected", () => {
  const verified = { source: "catalog" as const, provenance: { repo: "kyutai/pocket-tts-without-voice-cloning" }, revision: "r", sha256: "c".repeat(64), licence: "CC-BY-4.0", verifiedAt: new Date().toISOString(), modelPath: "/tmp/never/x" };
  upsertModel({ id: "tok", roles: ["tts"], ...verified, engineRequirements: { engine: "pocket-tts", component: "tokenizer" } });
  upsertModel({ id: "voice", roles: ["tts"], ...verified, engineRequirements: { engine: "pocket-tts", component: "voice" } });
  expect(selectedModel("tts")).toBeNull();
  expect(componentModel("tts", "tokenizer")?.id).toBe("tok");
  expect(componentModel("tts", "voice")?.id).toBe("voice");
});

test("the engines list names uv for tts with its own machine match and the pocket-tts environment as a managed row", async () => {
  const body = await (await app.request("/stack/v1/engines")).json() as { engines: Array<{ id: string; name: string; matchesThisMachine: boolean; installed: boolean }> };
  const uv = body.engines.filter((engine) => engine.name === "uv");
  expect(uv.length).toBe(3);
  expect(uv.filter((engine) => engine.matchesThisMachine).length).toBe(process.platform === "darwin" && process.arch === "arm64" ? 1 : process.platform === "linux" ? 1 : 0);
  expect(body.engines.find((engine) => engine.id === "pocket-tts-3.1.0")).toMatchObject({ name: "pocket-tts", installed: false, matchesThisMachine: true });
});

test("an install by a shipped pin's id lands the way the pin says: the hub file placement and the component come from the pin when the body leaves them out", async () => {
  const { STACK_TTS_TOKENIZER } = await import("@/lib/modelCatalog");
  const pin = STACK_TTS_TOKENIZER;
  // The body carries only what the pull route requires; no hub_file, no component.
  const response = await app.request("/stack/v1/models", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: pin.id, role: pin.role, repo: pin.repo, url: "http://127.0.0.1:9/never", sha256: pin.download!.sha256, approx_bytes: 1, licence: pin.license, revision: pin.revision }) });
  expect(response.status).toBe(202);
  const { getModel } = await import("@/lib/modelStore");
  const record = getModel(pin.id)!;
  expect(record.engineRequirements.component).toBe("tokenizer");
  expect(record.engineRequirements.engine).toBe("pocket-tts");
});

test("a redacted secret written back is no change: the real token stays, and so does a pending one", () => {
  updateSettings({ "stack.engines.tts.hf_token": "hf_realtoken" });
  applyPendingSettings();
  updateSettings({ "stack.engines.tts.hf_token": SECRET_SET });
  expect(readSettings().find((setting) => setting.key === "stack.engines.tts.hf_token")?.pending).toBeNull();
  expect(settingValues()["stack.engines.tts.hf_token"]).toBe("hf_realtoken");
  // A new token entered but not yet applied survives a write-all save.
  updateSettings({ "stack.engines.tts.hf_token": "hf_newtoken" });
  updateSettings({ "stack.engines.tts.hf_token": SECRET_SET, "stack.runtime.download_cap_mbps": 5 });
  expect(readSettings().find((setting) => setting.key === "stack.engines.tts.hf_token")?.pending).toBe(SECRET_SET);
  applyPendingSettings();
  expect(settingValues()["stack.engines.tts.hf_token"]).toBe("hf_newtoken");
  // The engine's environment never carries the daemon's own key.
  process.env.STACK_SECRETS_KEY = "0".repeat(64);
  try { expect(pocketTtsEnv().STACK_SECRETS_KEY).toBeUndefined(); } finally { delete process.env.STACK_SECRETS_KEY; }
  expect(pocketTtsEnv().HF_HUB_ETAG_TIMEOUT).toBe("3");
});

test("the uv rows are never reported as running an older build while tts serves", async () => {
  // A tts process whose build is pocket-tts, and a uv current link at the pin.
  setSupervisorFactoryForTests(async (role) => scriptedProcess(role, { identity: { host: "local", build: "pocket-tts-3.1.0", model: POCKET_TTS_UNGATED_REPO, healthy: true } }));
  const { getProcess } = await import("@/lib/supervisor");
  await getProcess("tts");
  const { engineCurrentPath, engineTagRoot } = await import("@/lib/store/layout");
  const { symlinkSync } = await import("node:fs");
  mkdirSync(engineTagRoot("uv", "0.12.17"), { recursive: true });
  try { symlinkSync("0.12.17", engineCurrentPath("uv")); } catch { /* left by an earlier run */ }
  try {
    const body = await (await app.request("/stack/v1/engines")).json() as { engines: Array<{ name: string; stateReason: string | null; state: string; roleState: string }> };
    const uv = body.engines.filter((candidate) => candidate.name === "uv");
    expect(uv.length).toBe(3);
    for (const engine of uv) { expect(engine.roleState).toBe("ready"); expect(engine.stateReason).not.toBe("newer installed"); }
  } finally {
    rmSync(engineTagRoot("uv", "0.12.17").replace(/\/0\.12\.17$/, ""), { recursive: true, force: true });
  }
});

test("a Pocket TTS environment built before the marker rename is recognised and renamed once", async () => {
  const { ENGINE_READY_MARKER } = await import("@/lib/engineCatalog");
  const { ENV_READY_MARKER } = await import("@/lib/uvEnvironment");
  const { writeEngineManifest } = await import("@/lib/store/manifests");
  const { pocketTtsInstalled, pocketTtsRoot, pocketTtsBinary } = await import("@/speech/pocketTts");
  const root = pocketTtsRoot();
  mkdirSync(join(root, "venv", "bin"), { recursive: true });
  writeFileSync(pocketTtsBinary(), "");
  writeFileSync(join(root, ENGINE_READY_MARKER), "old");
  writeEngineManifest({ kind: "engine", name: "pocket-tts", tag: "3.1.0", assetUrl: "requirements:pocket-tts.darwin-arm64.requirements.txt", sizeBytes: 0, sha256: "", extractedAt: "now", blobs: [] });
  expect(pocketTtsInstalled()).toBe(true);
  expect(existsSync(join(root, ENV_READY_MARKER))).toBe(true);
  expect(existsSync(join(root, ENGINE_READY_MARKER))).toBe(false);
  rmSync(join(root, ".."), { recursive: true, force: true });
});
