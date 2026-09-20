// STACK-93: mlx-serve as the second chat engine. Its pin selects by
// name, the chat engine setting picks the engine after a restart, a
// model record serves only its engine, the launch is mlx-serve's own
// command on loopback, a directory model installs file by file with
// every checksum, and the engines list names the pin for chat.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/app";
import { CHAT_ENGINES, ENGINE_READY_MARKER, engineRole, MLX_SERVE_PIN, selectEngineBinary } from "@/lib/engineCatalog";
import { engineDir } from "@/lib/engineInstall";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit, getGovernorStatus, release } from "@/lib/governor";
import { __resetHealthForTests, list as listHealth } from "@/lib/health";
import { clearModelsForTests, installCatalogModel, refuseUnsafeModelId, removeModel, upsertModel } from "@/lib/modelStore";
import { modelsDir } from "@/lib/paths";
import { readModelManifest } from "@/lib/store/manifests";
import { chatEngine, getProcess, getRoleStatus, launchPlan, resetSupervisorForTests, runningEngine, scriptedProcess, selectedModel, setSupervisorFactoryForTests } from "@/lib/supervisor";
import { __resetSettingsForTests, applyPendingSettings, readSettings, updateSettings } from "@/settings";
import { stagingPin, swapEngine, updateSwapOptions } from "@/updates/engines";
import { __resetUpdatesForTests, ModelIndexEntrySchema } from "@/updates/catalog";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { pullSpec } from "@/routes/models";
import { STACK_MLX_CHAT_MODEL } from "@/lib/modelCatalog";

beforeEach(() => { __resetHealthForTests(); __resetSettingsForTests(); clearModelsForTests(); });
afterEach(() => { setSupervisorFactoryForTests(null); resetSupervisorForTests(); clearModelsForTests(); __resetSettingsForTests(); });

const verified = { source: "catalog" as const, provenance: {}, revision: "r", sha256: "a".repeat(64), licence: "Apache-2.0", verifiedAt: new Date().toISOString() };
function twoChatModels(): void {
  upsertModel({ id: "gguf-chat", roles: ["chat"], ...verified, modelPath: "/tmp/never/chat.gguf", engineRequirements: { engine: "llama-server" } });
  upsertModel({ id: "mlx-chat", roles: ["chat"], ...verified, modelPath: "/tmp/never/Qwen3-1.7B-4bit", engineRequirements: { engine: "mlx-serve" } });
}

test("the mlx-serve pin is the second chat engine, selected by name for an Apple silicon Mac and for nothing else", () => {
  expect(CHAT_ENGINES).toEqual(["llama-server", "mlx-serve"]);
  expect(selectEngineBinary({ platform: "darwin", arch: "arm64", cudaDevices: [] } as never, "mlx-serve")?.id).toBe(MLX_SERVE_PIN.id);
  expect(selectEngineBinary({ platform: "darwin", arch: "arm64", cudaDevices: [] } as never)?.name).toBe("llama-server");
  expect(selectEngineBinary({ platform: "linux", arch: "arm64", cudaDevices: [] } as never, "mlx-serve")).toBeNull();
  expect(engineRole("mlx-serve")).toBe("chat");
  expect(MLX_SERVE_PIN.tool).toBe("mlx-serve");
});

const APPLE_SILICON = process.platform === "darwin" && process.arch === "arm64";

test.skipIf(!APPLE_SILICON)("the chat engine is llama-server until the setting says mlx-serve and a restart applies it; the chosen engine's model is the selected one", () => {
  twoChatModels();
  expect(chatEngine()).toBe("llama-server");
  expect(selectedModel("chat")?.id).toBe("gguf-chat");
  updateSettings({ "stack.engines.chat.engine": "mlx-serve" });
  expect(readSettings().find((setting) => setting.key === "stack.engines.chat.engine")?.pending).toBe("mlx-serve");
  expect(chatEngine()).toBe("llama-server");
  applyPendingSettings();
  expect(chatEngine()).toBe("mlx-serve");
  expect(selectedModel("chat")?.id).toBe("mlx-chat");
  expect(() => updateSettings({ "stack.engines.chat.engine": "vllm" })).toThrow();
});

test.skipIf(!APPLE_SILICON)("the launch for mlx-serve is its own command on loopback with the model directory, the context length and one slot", () => {
  twoChatModels();
  updateSettings({ "stack.engines.chat.engine": "mlx-serve" });
  applyPendingSettings();
  // An installed build: the pin's directory with its binary and marker.
  mkdirSync(engineDir(MLX_SERVE_PIN), { recursive: true });
  writeFileSync(join(engineDir(MLX_SERVE_PIN), "mlx-serve"), "");
  writeFileSync(join(engineDir(MLX_SERVE_PIN), ENGINE_READY_MARKER), "now");
  try {
    const plan = launchPlan("chat", selectedModel("chat")!, 8797);
    expect(plan.engine).toBe("mlx-serve");
    expect(plan.build).toBe("v26.9.4");
    expect(plan.kind).toBe("spawned");
    expect(plan.command[0]).toMatch(/\/engines\/mlx-serve\/v26\.9\.4\/mlx-serve$/);
    expect(plan.command.slice(1)).toEqual(["--model", "/tmp/never/Qwen3-1.7B-4bit", "--serve", "--host", "127.0.0.1", "--port", "8797", "--ctx-size", "4096", "--max-concurrent", "1"]);
    expect(plan.env?.HOME).toContain("/home");
  } finally {
    rmSync(join(engineDir(MLX_SERVE_PIN), ".."), { recursive: true, force: true });
  }
});

test("a directory model installs file by file, each verified, into one directory that is the model path, and removes as one", async () => {
  const files = Object.fromEntries(["model.safetensors", "config.json", "tokenizer.json"].map((name) => [name, Buffer.from(`${name}:${"x".repeat(100)}`)]));
  const sha = (name: string) => createHash("sha256").update(files[name]!).digest("hex");
  const fetched: string[] = [];
  const progress: Array<{ completedBytes: number; totalBytes: number }> = [];
  const pin = {
    id: "mlx-test", role: "chat" as const, repo: "mlx-community/test", license: "Apache-2.0", revision: "rev1", engine: "mlx-serve",
    download: { url: "https://huggingface.co/mlx-community/test/resolve/rev1/model.safetensors", sha256: sha("model.safetensors"), approx_bytes: 300, directory: "test-4bit", files: Object.keys(files).map((name) => ({ path: name, sha256: sha(name), bytes: files[name]!.length })) },
  };
  const installed = await installCatalogModel(pin, {
    destination: join(modelsDir, pin.id, "model.safetensors"),
    onProgress: (step) => { progress.push({ completedBytes: step.completedBytes, totalBytes: step.totalBytes }); },
    download: async (url, destination, downloadOptions) => { const name = url.split("/").pop()!; fetched.push(name); mkdirSync(join(destination, ".."), { recursive: true }); writeFileSync(destination, files[name]!); downloadOptions?.onProgress?.({ completedBytes: files[name]!.length, totalBytes: files[name]!.length, status: "downloading" }); },
  });
  expect(installed.modelPath).toBe(join(modelsDir, pin.id, "test-4bit"));
  for (const name of Object.keys(files)) expect(readFileSync(join(installed.modelPath!, name)).equals(files[name]!)).toBe(true);
  expect(fetched.sort()).toEqual(["config.json", "model.safetensors", "tokenizer.json"]);
  const manifest = readModelManifest(pin.id)!;
  expect(manifest.blobs.length).toBe(3);
  expect(manifest.blobs.map((blob) => blob.digest).sort()).toEqual(Object.keys(files).map(sha).sort());
  expect(manifest.sizeBytes).toBe(Object.values(files).reduce((sum, file) => sum + file.length, 0));
  // Progress counts every file: the weights first, then each of the rest, against the directory's total.
  const total = Object.values(files).reduce((sum, file) => sum + file.length, 0);
  expect(progress.every((step) => step.totalBytes === total)).toBe(true);
  expect(progress.at(-1)?.completedBytes).toBe(total);
  // A re-install verifies the placed weights and fetches nothing that is already there.
  fetched.length = 0;
  rmSync(join(installed.modelPath!, "config.json"));
  const again = await installCatalogModel(pin, { destination: join(modelsDir, pin.id, "model.safetensors"), download: async (url, destination) => { const name = url.split("/").pop()!; fetched.push(name); writeFileSync(destination, files[name]!); } });
  expect(again.modelPath).toBe(installed.modelPath);
  expect(fetched).toEqual(["config.json"]);
  // A weights path with a directory component lands in it.
  const nested = { ...pin, id: "mlx-nested", download: { ...pin.download, url: "https://huggingface.co/mlx-community/test/resolve/rev1/weights/model.safetensors", files: pin.download.files.map((file) => file.path === "model.safetensors" ? { ...file, path: "weights/model.safetensors" } : file) } };
  const placed = await installCatalogModel(nested, { destination: join(modelsDir, nested.id, "model.safetensors"), download: async (url, destination) => { const name = url.split("/").pop()!; mkdirSync(join(destination, ".."), { recursive: true }); writeFileSync(destination, files[name]!); } });
  expect(existsSync(join(placed.modelPath!, "weights", "model.safetensors"))).toBe(true);
  expect(removeModel(nested.id)).toBe(true);
  // A corrupt secondary file is refused, the record never verified, and the same health item raised as for the weights.
  const badPin = { ...pin, id: "mlx-bad", download: { ...pin.download, files: pin.download.files.map((file) => file.path === "config.json" ? { ...file, sha256: "0".repeat(64) } : file) } };
  await expect(installCatalogModel(badPin, { destination: join(modelsDir, badPin.id, "model.safetensors"), download: async (url, destination) => { const name = url.split("/").pop()!; mkdirSync(join(destination, ".."), { recursive: true }); writeFileSync(destination, files[name]!); } })).rejects.toThrow(/checksum/);
  expect(listHealth().find((item) => item.code === "stored-blob-checksum-mismatch")?.text).toMatch(/config\.json for mlx-bad/);
  expect(removeModel(pin.id)).toBe(true);
  expect(existsSync(join(modelsDir, pin.id, "test-4bit"))).toBe(false);
  // The failed install left its placed weights; dropping the record sweeps the model's own directory.
  expect(existsSync(join(modelsDir, badPin.id))).toBe(true);
  upsertModel({ id: badPin.id, roles: ["chat"], source: "catalog", provenance: {}, revision: "r", sha256: null, licence: "Apache-2.0", verifiedAt: null, modelPath: null });
  expect(removeModel(badPin.id)).toBe(true);
  expect(existsSync(join(modelsDir, badPin.id))).toBe(false);
  // Hugging Face's own download form of the URL names the same weights file.
  const queried = await installCatalogModel({ ...pin, id: "mlx-query", download: { ...pin.download, url: `${pin.download.url}?download=true` } }, { destination: join(modelsDir, "mlx-query", "model.safetensors"), download: async (url, destination) => { expect(url).not.toMatch(/\?download=true\/|json\?|txt\?/); const name = new URL(url).pathname.split("/").pop()!; mkdirSync(join(destination, ".."), { recursive: true }); writeFileSync(destination, files[name]!); } });
  expect(queried.modelPath).toBe(join(modelsDir, "mlx-query", "test-4bit"));
  expect(removeModel("mlx-query")).toBe(true);
  // A directory that is not the model's own is refused before anything moves.
  await expect(installCatalogModel({ ...pin, id: "mlx-dir", download: { ...pin.download, directory: "../other" } }, { destination: join(modelsDir, "mlx-dir", "model.safetensors"), download: async () => { throw new Error("must not fetch"); } })).rejects.toThrow(/directory outside its own/);
  // A pinned path that leaves the directory is refused before it is written.
  await expect(installCatalogModel({ ...pin, id: "mlx-escape", download: { ...pin.download, files: [...pin.download.files, { path: "../../escape.json", sha256: sha("config.json"), bytes: 1 }] } }, { destination: join(modelsDir, "mlx-escape", "model.safetensors"), download: async (url, destination) => { const name = url.split("/").pop()!; mkdirSync(join(destination, ".."), { recursive: true }); writeFileSync(destination, files[name] ?? "x"); } })).rejects.toThrow(/outside its directory/);
  expect(existsSync(join(modelsDir, "escape.json"))).toBe(false);
  // A URL naming a file the pin does not list is refused before any byte moves.
  await expect(installCatalogModel({ ...pin, id: "mlx-odd", download: { ...pin.download, url: "https://example.com/other/weights.bin" } }, { destination: join(modelsDir, "mlx-odd", "weights.bin"), download: async () => { throw new Error("must not fetch"); } })).rejects.toThrow(/names none of them/);
});

test("a model id is a plain name, never one of the store's own directories, so a remove sweeps only the model's directory", async () => {
  for (const id of ["hub", "manifests", "..", "a/b", "", "hub/x"]) expect(() => refuseUnsafeModelId(id)).toThrow();
  refuseUnsafeModelId("qwen3-1.7b-mlx-4bit");
  for (const id of ["hub", "manifests"]) {
    const response = await app.request("/stack/v1/models", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, role: "chat", url: "https://example.com/m.gguf", sha256: "a".repeat(64), licence: "Apache-2.0", revision: "r" }) });
    expect(response.status).toBe(400);
  }
  // A record that somehow carries such an id never takes the store's directory with it.
  mkdirSync(join(modelsDir, "hub", "keep"), { recursive: true });
  writeFileSync(join(modelsDir, "hub", "keep", "blob"), "x");
  upsertModel({ id: "hub", roles: ["chat"], source: "catalog", provenance: {}, revision: "r", sha256: null, licence: "Apache-2.0", verifiedAt: null, modelPath: null });
  expect(removeModel("hub")).toBe(true);
  expect(existsSync(join(modelsDir, "hub", "keep", "blob"))).toBe(true);
  rmSync(join(modelsDir, "hub", "keep"), { recursive: true, force: true });
});

test("a staged build of mlx-serve carries the engine's own binary name, as the shipped pin does", () => {
  expect(stagingPin("mlx-serve", "v26.9.5", { url: "https://example.com/mlx-serve.tar.gz", sha256: "a".repeat(64), size: 1 }).tool).toBe("mlx-serve");
  expect(stagingPin("llama-server", "b10800", { url: "https://example.com/llama.zip", sha256: "a".repeat(64), size: 1 }).tool).toBeUndefined();
});

test.skipIf(!APPLE_SILICON)("the engines list names mlx-serve's pin for chat beside llama-server's, and only the chosen engine's row carries the running build", async () => {
  setSupervisorFactoryForTests(async (role) => scriptedProcess(role));
  twoChatModels();
  updateSettings({ "stack.engines.chat.engine": "mlx-serve" });
  applyPendingSettings();
  // Both installed: each pin's directory with its marker and a current link at its tag.
  for (const pin of [MLX_SERVE_PIN, selectEngineBinary({ platform: "darwin", arch: "arm64", cudaDevices: [] } as never, "llama-server")!]) {
    mkdirSync(engineDir(pin), { recursive: true });
    writeFileSync(join(engineDir(pin), ENGINE_READY_MARKER), "now");
    symlinkSync(pin.tag, join(engineDir(pin), "..", "current"));
  }
  try {
    type Row = { id: string; name: string; matchesThisMachine: boolean; running: string | null; state: string; stateReason: string | null; needsRestart: boolean };
    const rows = async () => (await (await app.request("/stack/v1/engines")).json() as { engines: Row[] }).engines;
    const mlxRow = (engines: Row[]) => engines.find((engine) => engine.id === MLX_SERVE_PIN.id)!;
    const llamaRow = (engines: Row[]) => engines.find((engine) => engine.name === "llama-server" && engine.matchesThisMachine)!;
    // Nothing runs yet: neither row carries a running build, both are current.
    let engines = await rows();
    expect(mlxRow(engines).matchesThisMachine).toBe(process.platform === "darwin" && process.arch === "arm64");
    expect(mlxRow(engines).running).toBeNull();
    expect(llamaRow(engines).running).toBeNull();
    expect(llamaRow(engines).state).toBe("current");
    // The process that runs the chat role is an mlx-serve at its tag; its row carries the build, llama-server's stays clean.
    // The factory scripts whichever engine the test says at spawn time, so a later start spawns the other without a reset.
    let scripted: "mlx-serve" | "llama-server" = "mlx-serve";
    setSupervisorFactoryForTests(async (role) => scriptedProcess(role, { engine: scripted, identity: { host: "stub", build: scripted === "mlx-serve" ? `mlx-serve-${MLX_SERVE_PIN.tag}` : "b10797", model: "scripted", healthy: true } }));
    await getProcess("chat");
    engines = await rows();
    expect(mlxRow(engines)).toMatchObject({ running: `mlx-serve-${MLX_SERVE_PIN.tag}`, state: "current", stateReason: null });
    expect(llamaRow(engines)).toMatchObject({ running: null, state: "current", stateReason: null });
    // A pending engine change is a restart on the chosen engine's row; until the restart the
    // running mlx-serve is still the process the list describes, and the one a stop stops.
    updateSettings({ "stack.engines.chat.engine": "llama-server" });
    engines = await rows();
    expect(mlxRow(engines)).toMatchObject({ running: `mlx-serve-${MLX_SERVE_PIN.tag}`, needsRestart: true, state: "current" });
    expect(llamaRow(engines)).toMatchObject({ running: null, state: "current" });
    const control = async (name: string, action: string) => (await (await app.request(`/stack/v1/engines/${name}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()) as { ok: boolean; reason?: string };
    expect(await control("llama-server", "stop")).toMatchObject({ ok: false, reason: "The chat role is not running llama-server." });
    applyPendingSettings();
    expect((await control("mlx-serve", "restart")).reason).toBe("The chat role is set to llama-server (mlx-serve runs until the restart); set stack.engines.chat.engine to mlx-serve and restart the Stack to run it.");
    // The scheduled update of the engine not chosen moves its link without touching the running process.
    mkdirSync(join(engineDir(MLX_SERVE_PIN), "..", "v26.9.5"), { recursive: true });
    writeFileSync(join(engineDir(MLX_SERVE_PIN), "..", "v26.9.5", ENGINE_READY_MARKER), "now");
    await swapEngine("mlx-serve", "v26.9.5", updateSwapOptions("mlx-serve"));
    expect(getRoleStatus("chat").state).toBe("ready");
    expect(updateSwapOptions("llama-server").drain).toBeDefined();
    expect(updateSwapOptions("mlx-serve").drain).toBeUndefined();
    // A start of the chosen engine while the other still holds the role is a real start, never "already running".
    expect(runningEngine("chat")).toBe("mlx-serve");
    scripted = "llama-server";
    expect(await control("llama-server", "start")).toEqual({ ok: true });
    expect(runningEngine("chat")).toBe("llama-server");
    expect(await control("llama-server", "start")).toEqual({ ok: true, reason: "Already running." });
    expect(await control("llama-server", "stop")).toEqual({ ok: true });
    expect(getRoleStatus("chat").state).not.toBe("ready");
    // Stopped, with llama-server chosen: llama-server's stop is a no-op that is allowed, mlx-serve's is not its process.
    expect(await control("llama-server", "stop")).toEqual({ ok: true });
    expect(await control("mlx-serve", "stop")).toMatchObject({ ok: false });
    // An engine with no pinned build for this machine cannot be chosen; the value in effect can always be written back.
    expect(() => updateSettings({ "stack.engines.chat.engine": "vllm" })).toThrow();
    expect(() => updateSettings({ "stack.engines.chat.engine": "llama-server" })).not.toThrow();
  } finally {
    rmSync(join(engineDir(MLX_SERVE_PIN), "..", ".."), { recursive: true, force: true });
  }
});

test("the governor sizes the two chat engines by their own multipliers and holds them side by side until the margin says no", async () => {
  const GB = 1_073_741_824;
  __resetGovernorForTests();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 24 * GB, freeMemoryBytes: 9 * GB, tier: "p16" });
  try {
    // The laptop's numbers: the MLX pin's 984 MB at 1.4, the GGUF pin's 1.83 GB at 1.3.
    const mlx = await admit({ id: "chat:mlx", kind: "resident", requestedBytes: 0, modelFileBytes: 984_013_244, engine: "mlx-serve" });
    expect("id" in mlx).toBe(true);
    expect(getGovernorStatus().loaded.find((item) => item.id === "chat:mlx")?.peakBytes).toBe(Math.ceil(984_013_244 * 1.4));
    const gguf = await admit({ id: "chat:gguf", kind: "resident", requestedBytes: 0, modelFileBytes: 1_834_426_016, engine: "llama-server" });
    expect("id" in gguf).toBe(true);
    expect(getGovernorStatus().loaded.find((item) => item.id === "chat:gguf")?.peakBytes).toBe(Math.ceil(1_834_426_016 * 1.3));
    // A third resident that would eat into the p16 margin (4 GB) waits: 6 GB more of the 9 GB free would leave 3 GB.
    expect(await admit({ id: "embed:big", kind: "resident", requestedBytes: 6 * GB, engine: "llama-server" })).toEqual({ queued: true, position: 1 });
    release(mlx as { id: string; kind: "resident"; requestedBytes: number });
    release(gguf as { id: string; kind: "resident"; requestedBytes: number });
  } finally {
    await Bun.sleep(5);
    __resetGovernorForTests();
  }
});

test("a pull by id lands a directory model as the shipped pin says, even when the Catalog's entry for the id carries no file list", async () => {
  const body = { id: STACK_MLX_CHAT_MODEL.id, role: "chat" as const, url: STACK_MLX_CHAT_MODEL.download!.url, sha256: STACK_MLX_CHAT_MODEL.download!.sha256, licence: "Apache-2.0", revision: STACK_MLX_CHAT_MODEL.revision! };
  const spec = pullSpec(body);
  expect(spec.download.directory).toBe("Qwen3-1.7B-4bit");
  expect(spec.download.files?.length).toBe(9);
  expect(spec.engine).toBe("mlx-serve");
  // The shipped list is the shipped revision's: a pull of the id at another revision gets none of its hashes, and the route refuses it.
  expect(pullSpec({ ...body, revision: "other" }).download.files).toBeUndefined();
  const refused = await app.request("/stack/v1/models", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, revision: "other" }) });
  expect(refused.status).toBe(400);
  expect((await refused.json() as { error: string }).error).toMatch(/needs its pinned file list/);
  // Half of the directory shape is refused before any byte moves.
  await expect(installCatalogModel({ ...STACK_MLX_CHAT_MODEL, id: "mlx-half", download: { ...STACK_MLX_CHAT_MODEL.download!, directory: undefined } }, { destination: join(modelsDir, "mlx-half", "model.safetensors"), download: async () => { throw new Error("must not fetch"); } })).rejects.toThrow(/files without a directory/);
  // A Catalog entry for the id at another revision without the list gets no list: the shipped hashes are not that revision's.
  const index = JSON.stringify({ version: "1", models: [{ id: STACK_MLX_CHAT_MODEL.id, role: "chat", profile: "p16", quality: 1, revision: "newer", download: { url: "https://huggingface.co/mlx-community/Qwen3-1.7B-4bit/resolve/newer/model.safetensors", sha256: "b".repeat(64), approx_bytes: 1 } }] });
  db.insert(meta).values({ key: "updates.modelIndex.body", value: index }).onConflictDoUpdate({ target: meta.key, set: { value: index } }).run();
  try {
    const newer = pullSpec({ ...body, revision: "newer" });
    expect(newer.revision).toBe("newer");
    expect(newer.download.files).toBeUndefined();
    expect(newer.download.directory).toBeUndefined();
  } finally { __resetUpdatesForTests(); }
  // The Catalog's index shape can carry the list itself.
  expect(ModelIndexEntrySchema.safeParse({ id: "x", role: "chat", profile: "p16", quality: 1, revision: "r", download: { url: "https://example.com/m/model.safetensors", sha256: "a".repeat(64), approx_bytes: 1, directory: "m", files: [{ path: "model.safetensors", sha256: "a".repeat(64), bytes: 1 }] } }).success).toBe(true);
  // A hub file and a directory are two placements; a pin naming both is refused before any byte moves.
  expect(installCatalogModel({ ...STACK_MLX_CHAT_MODEL, id: "mlx-two", download: { ...STACK_MLX_CHAT_MODEL.download!, hub_file: "model.safetensors" } }, { destination: join(modelsDir, "mlx-two", "model.safetensors"), download: async () => { throw new Error("must not fetch"); } })).rejects.toThrow(/both a hub file and a directory/);
});
