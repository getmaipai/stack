// CODE-STACK-01 S5a: Splash is a process tree (the launcher that becomes the server, and
// the native engine under it). The Stack must pause the whole tree for chat, stop the
// whole tree, and leave no orphan holding memory. These tests use real short-lived
// processes (`sleep`, `sh`) and a stand-in for Splash (tests/helpers/fake-splash.ts) that
// is started by the Stack's real start path; no model is loaded and nothing is downloaded.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { __resetEventsForTests } from "@/lib/events";
import { ENGINE_READY_MARKER, SPLASH_PIN } from "@/lib/engineCatalog";
import { engineDir } from "@/lib/engineInstall";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, getGovernorStatus } from "@/lib/governor";
import { __resetHealthForTests, list as listHealth } from "@/lib/health";
import { heavyGate, PausableProcess } from "@/lib/heavyGate";
import { STACK_CODING_DRAFT_MODEL, STACK_CODING_MODEL } from "@/lib/modelCatalog";
import { clearModelsForTests, upsertModel } from "@/lib/modelStore";
import { modelsDir } from "@/lib/paths";
import { descendantsOf, isAlive, listProcessTable, parseProcessTable, processTree, TreeSnapshot } from "@/lib/processTree";
import { clearCodingEngineFailures } from "@/lib/splash";
import { splashHomeDir, splashHubDir, splashRoot, splashTmpDir } from "@/lib/splashStore";
import { codingEngineStatus, getProcess, getRoleStatus, identityCheck, requestRole, resetSupervisorForTests, setCodingMachineFacts, setMachineTier, setSupervisorFactoryForTests, stopRole } from "@/lib/supervisor";
import { __resetSettingsForTests } from "@/settings";

const GB = 1_073_741_824;
const onMac = process.platform === "darwin" && process.arch === "arm64";
const macTest = onMac ? test : test.skip;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stateOf = (pid: number): string => Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe" }).stdout.toString().trim();
const parentOf = (pid: number): number => Number(Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)], { stdout: "pipe" }).stdout.toString().trim());
async function until(condition: () => boolean, ms = 4000): Promise<void> { const end = Date.now() + ms; while (!condition() && Date.now() < end) await wait(20); }

const spawned: Array<{ kill(): void; pid: number }> = [];
afterEach(async () => {
  for (const child of spawned.splice(0)) { try { process.kill(child.pid, "SIGCONT"); } catch { /* gone */ } try { child.kill(); } catch { /* gone */ } }
  // Anything a test left behind in the fake's tree.
  for (const pid of leftovers.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
});
const leftovers: number[] = [];

/** `sh` whose one child is a `sleep`: a launcher with an engine under it. Resolves with both pids. */
async function treeOf(script = "sleep 600 & echo $!; wait"): Promise<{ root: ReturnType<typeof Bun.spawn>; rootPid: number; childPid: number }> {
  const root = Bun.spawn(["sh", "-c", script], { stdout: "pipe", stderr: "ignore" });
  spawned.push(root);
  const reader = root.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  const childPid = Number(new TextDecoder().decode(first.value).trim());
  leftovers.push(childPid);
  return { root, rootPid: root.pid, childPid };
}

// ---- finding the tree ---------------------------------------------------------------------

test("the process table is read as rows, and a tree is a root and everything under it, children before grandchildren", () => {
  const rows = parseProcessTable("  1     0\n 10     1\n 11    10\n 12    10\n 13    11\n 99     1\nnot a row\n");
  expect(rows).toEqual([{ pid: 1, ppid: 0 }, { pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 10 }, { pid: 13, ppid: 11 }, { pid: 99, ppid: 1 }]);
  expect(descendantsOf(10, rows)).toEqual([11, 12, 13]);
  expect(descendantsOf(13, rows)).toEqual([]);
  expect(processTree(10, rows)).toEqual([10, 11, 12, 13]);
  // A cycle in a corrupt table does not loop.
  expect(descendantsOf(1, [{ pid: 1, ppid: 2 }, { pid: 2, ppid: 1 }])).toEqual([2]);
});

test("the real process table finds a launcher and the engine under it", async () => {
  const { rootPid, childPid } = await treeOf();
  expect(parentOf(childPid)).toBe(rootPid);
  expect(processTree(rootPid, listProcessTable())).toEqual([rootPid, childPid]);
});

// ---- pausing the tree for chat ------------------------------------------------------------------

test("pausing a tree stops the engine under the launcher as well, and the resume continues both", async () => {
  const { root, rootPid, childPid } = await treeOf();
  const worker = new PausableProcess(rootPid, root.exited, { engine: true, tree: true });
  expect(worker.pause()).toBe(true);
  expect(stateOf(rootPid)).toMatch(/^T/);
  expect(stateOf(childPid)).toMatch(/^T/);
  expect(worker.paused).toBe(true);
  expect(worker.resume()).toBe(true);
  await until(() => !stateOf(childPid).startsWith("T") && !stateOf(rootPid).startsWith("T"));
  expect(stateOf(rootPid)).not.toMatch(/^T/);
  expect(stateOf(childPid)).not.toMatch(/^T/);
  expect(worker.paused).toBe(false);
});

test("a worker that is not a tree still stops only its own pid (every other worker is unchanged)", async () => {
  const { root, rootPid, childPid } = await treeOf();
  const worker = new PausableProcess(rootPid, root.exited, { engine: true });
  expect(worker.pause()).toBe(true);
  expect(stateOf(rootPid)).toMatch(/^T/);
  expect(stateOf(childPid)).not.toMatch(/^T/);
  worker.resume();
});

test("the gate's yield to chat reaches the engine child: chat starts, the tree stops; chat ends and the tail passes, the tree runs", async () => {
  const { root, rootPid, childPid } = await treeOf();
  const worker = new PausableProcess(rootPid, root.exited, { engine: true, tree: true });
  heavyGate.reset();
  process.env.STACK_ISOLATION_TAIL_MS = "40";
  try {
    const lease = heavyGate.attach({ role: "coding", worker, skipCoding: true, maxPauseMs: () => 60_000, enabled: () => true });
    const done = heavyGate.begin("chat");
    expect(stateOf(childPid)).toMatch(/^T/);
    expect(stateOf(rootPid)).toMatch(/^T/);
    done();
    await until(() => !stateOf(childPid).startsWith("T") && !stateOf(rootPid).startsWith("T"), 3000);
    expect(stateOf(childPid)).not.toMatch(/^T/);
    expect(stateOf(rootPid)).not.toMatch(/^T/);
    lease.detach();
  } finally { delete process.env.STACK_ISOLATION_TAIL_MS; heavyGate.reset(); }
});

test("a stopped tree is continued before it is killed, so the stop is never held by a stopped process", async () => {
  const { root, rootPid, childPid } = await treeOf();
  const worker = new PausableProcess(rootPid, root.exited, { engine: true, tree: true });
  worker.pause();
  const tree = new TreeSnapshot(rootPid);
  tree.refresh();
  worker.resume();
  await tree.stopAll(2000);
  await root.exited;
  expect(isAlive(rootPid)).toBe(false);
  await until(() => !isAlive(childPid));
  expect(isAlive(childPid)).toBe(false);
});

// ---- stopping the tree: no orphan ------------------------------------------------------------------

test("when the launcher dies on its own the engine under it is not left behind", async () => {
  const { root, rootPid, childPid } = await treeOf();
  const tree = new TreeSnapshot(rootPid);
  tree.refresh();
  process.kill(rootPid, "SIGKILL");
  await root.exited;
  // The child now belongs to launchd, where a parent search could never find it again.
  await until(() => parentOf(childPid) === 1);
  expect(isAlive(childPid)).toBe(true);
  expect(tree.survivors()).toEqual([childPid]);
  await tree.stopAll(2000);
  await until(() => !isAlive(childPid));
  expect(isAlive(childPid)).toBe(false);
  expect(tree.survivors()).toEqual([]);
});

test("a member that ignores the polite stop is stopped hard after the grace period, and nothing is left", async () => {
  // The engine child inherits an ignored SIGTERM from its parent.
  const { root, rootPid, childPid } = await treeOf('trap "" TERM; sleep 600 & echo $!; wait');
  const tree = new TreeSnapshot(rootPid);
  tree.refresh();
  const startedAt = Date.now();
  await tree.stopAll(300);
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
  await root.exited;
  await until(() => !isAlive(childPid));
  expect(isAlive(rootPid)).toBe(false);
  expect(isAlive(childPid)).toBe(false);
  expect(tree.survivors()).toEqual([]);
});

test("a pid that has since become another program is left alone", async () => {
  const { root, rootPid, childPid } = await treeOf();
  const tree = new TreeSnapshot(rootPid);
  tree.refresh();
  expect(tree.survivors().sort()).toEqual([rootPid, childPid].sort());
  // The members are remembered with their command lines; a different command at the same pid is not one of them.
  (tree as unknown as { members: Map<number, string> }).members.set(childPid, "/usr/bin/some-other-program --with args");
  expect(tree.survivors()).toEqual([rootPid]);
  process.kill(rootPid, "SIGKILL");
  await root.exited;
});

// ---- the whole start path with a stand-in for Splash ---------------------------------------------------

const fakeSplash = join(import.meta.dir, "helpers", "fake-splash.ts");

/** Splash installed as its archive extracts: the native engine file, the bundled Python (a shell script that runs the stand-in), and the launcher. */
function installFakeSplash(): void {
  const dir = engineDir(SPLASH_PIN);
  mkdirSync(join(dir, "engine"), { recursive: true });
  mkdirSync(join(dir, "python", "bin"), { recursive: true });
  mkdirSync(join(dir, "install"), { recursive: true });
  writeFileSync(join(dir, "engine", "splash"), "");
  writeFileSync(join(dir, "install", "launcher.py"), "# the stand-in ignores this file\n");
  writeFileSync(join(dir, "python", "bin", "python3"), '#!/bin/sh\nexec "$FAKE_BUN" run "$FAKE_SPLASH_SCRIPT" "$@"\n');
  chmodSync(join(dir, "python", "bin", "python3"), 0o755);
  writeFileSync(join(dir, ENGINE_READY_MARKER), "now");
  process.env.FAKE_BUN = process.execPath;
  process.env.FAKE_SPLASH_SCRIPT = fakeSplash;
}
function installRecords(): void {
  const now = new Date().toISOString();
  const model = STACK_CODING_MODEL;
  const draft = STACK_CODING_DRAFT_MODEL;
  const modelPath = join(modelsDir, "imports", model.id, model.download!.sha256);
  mkdirSync(dirname(modelPath), { recursive: true });
  writeFileSync(modelPath, ""); truncateSync(modelPath, model.download!.approx_bytes);
  upsertModel({ id: model.id, roles: ["coding"], source: "catalog", provenance: { repo: model.repo }, revision: model.revision!, sha256: model.download!.sha256, sizeBytes: model.download!.approx_bytes, licence: "Apache-2.0", installedAt: now, verifiedAt: now, modelPath, engineRequirements: { engine: "llama-server" } });
  const draftDir = join(modelsDir, draft.id, draft.download!.directory!);
  for (const file of draft.download!.files!) { mkdirSync(draftDir, { recursive: true }); writeFileSync(join(draftDir, file.path), ""); truncateSync(join(draftDir, file.path), file.bytes); }
  upsertModel({ id: draft.id, roles: ["coding"], source: "catalog", provenance: { repo: draft.repo }, revision: draft.revision!, sha256: draft.download!.sha256, sizeBytes: draft.download!.approx_bytes, licence: "Apache-2.0", installedAt: now, verifiedAt: now, modelPath: draftDir, engineRequirements: { engine: "splash", component: "draft" } });
}
const report = (): { pid: number; childPid: number; argv: string[]; env: Record<string, string | null> } => JSON.parse(readFileSync(join(splashTmpDir(), "fake-splash.json"), "utf8"));

beforeEach(() => {
  __resetEventsForTests(); __resetHealthForTests(); __resetGovernorForTests(); __resetSettingsForTests(); clearModelsForTests(); clearCodingEngineFailures();
  setMachineTier("p128");
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 100 * GB, tier: "p128" });
  setSupervisorFactoryForTests(null);
  setCodingMachineFacts({ platform: "darwin", arch: "arm64", chipGeneration: 5, chipName: "Apple M5 Max", memoryGb: 128, osVersion: "27.0.1" });
});
afterEach(async () => {
  await stopRole("coding").catch(() => {});
  for (const key of ["FAKE_BUN", "FAKE_SPLASH_SCRIPT", "FAKE_SPLASH_REFUSE", "FAKE_SPLASH_WRONG_NAME", "FAKE_SPLASH_NOT_SPLASH", "HF_TOKEN", "STACK_SECRETS_KEY", "PYTHONPATH"]) delete process.env[key];
  setMachineTier(null); setCodingMachineFacts(null); resetSupervisorForTests(); clearCodingEngineFailures(); clearModelsForTests(); __resetGovernorForTests(); __resetSettingsForTests();
  rmSync(join(engineDir(SPLASH_PIN), ".."), { recursive: true, force: true });
  rmSync(splashRoot(), { recursive: true, force: true });
  rmSync(join(modelsDir, "imports"), { recursive: true, force: true });
  rmSync(join(modelsDir, STACK_CODING_DRAFT_MODEL.id), { recursive: true, force: true });
});

macTest("the first coding request starts Splash through the real start path: launched offline from the Stack's folders, checked, admitted, and reported as the engine serving", async () => {
  installFakeSplash(); installRecords();
  process.env.HF_TOKEN = "hf_must_not_reach_splash"; process.env.STACK_SECRETS_KEY = "must-not-reach-splash"; process.env.PYTHONPATH = "/must/not/reach/splash";
  const started = await getProcess("coding");
  expect(started).toMatchObject({ role: "coding", kind: "spawned", engine: "splash", contextLength: 131_072, slots: 2, contextScope: "total across slots", modelId: "qwen3.8-27b-ud-q4-k-m" });
  expect(started.identity).toMatchObject({ build: "splash-1.3.2-ornith.1", healthy: true });
  expect(identityCheck("coding")).toMatchObject({ ok: true });
  const seen = report();
  // The arguments after the launcher, as the Stack built them.
  expect(seen.argv).toEqual([
    "--model", "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M", "--revision", "4ca720788d1e01f1bff70c033e0d0028fd02e502", "--offline", "--host", "127.0.0.1", "--port", String(started.port),
    "--language-only", "--served-model-name", "qwen3.8-27b-ud-q4-k-m", "--announce-served-name", "--default-reasoning-effort", "medium", "--thinking-token-budget", "2000",
    "--max-context", "131072", "--max-cache-disk", "8G", "--idle-release", "off", "--no-webui",
  ]);
  expect(seen.env).toMatchObject({ HOME: splashHomeDir(), TMPDIR: splashTmpDir(), HF_HOME: splashHomeDir(), HF_HUB_CACHE: splashHubDir(), HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", DO_NOT_TRACK: "1", HF_HUB_DISABLE_TELEMETRY: "1", HF_TOKEN: null, HUGGING_FACE_HUB_TOKEN: null, STACK_SECRETS_KEY: null, PYTHONPATH: null, SPLASH_API_KEY: null });
  // The Stack's files were laid out first, by hardlink.
  expect(existsSync(join(splashHubDir(), "models--incoai--Qwen3.8-27B-DFlash2", "refs", "main"))).toBe(true);
  // The tree is the server and the engine under it, and the Stack has the server's pid.
  expect(started.pid).toBe(seen.pid);
  expect(parentOf(seen.childPid)).toBe(seen.pid);
  // Status says which engine serves coding.
  expect(codingEngineStatus()).toMatchObject({ state: "ready", engine: "splash", engine_requested: "auto", engine_reason: null });
  expect(getRoleStatus("coding").state).toBe("ready");
  // The governor holds Splash under its own name, as an on-demand item that gives way to a generator.
  const loaded = getGovernorStatus().loaded.find((entry) => entry.id === "coding")!;
  expect(loaded).toMatchObject({ kind: "jit", pid: seen.pid });
  // No fallback warning: it just worked.
  expect(listHealth().filter((item) => item.code === "coding.engine-fallback")).toEqual([]);
});

macTest("a request reaches Splash under the one name it serves, whatever the client called the model", async () => {
  installFakeSplash(); installRecords();
  const reply = await requestRole("coding", "/v1/chat/completions", { model: "coding", messages: [{ role: "user", content: "hi" }] });
  expect(reply.status).toBe(200);
  const log = readFileSync(join(splashTmpDir(), "fake-splash-requests.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { path: string; model: string });
  // The post-load check and the request: both named qwen3.8-27b-ud-q4-k-m, neither "coding" (which Splash would answer with a 404).
  expect(log.length).toBeGreaterThanOrEqual(2);
  expect(log.every((entry) => entry.model === "qwen3.8-27b-ud-q4-k-m")).toBe(true);
});

macTest("chat pauses the whole Splash tree through the running coding process, and its end lets it run", async () => {
  installFakeSplash(); installRecords();
  const started = await getProcess("coding");
  const { childPid } = report();
  expect(started.pausable).toBeDefined();
  expect(started.pausable!.pause()).toBe(true);
  expect(stateOf(started.pid!)).toMatch(/^T/);
  expect(stateOf(childPid)).toMatch(/^T/);
  started.pausable!.resume();
  await until(() => !stateOf(childPid).startsWith("T"));
  expect(stateOf(childPid)).not.toMatch(/^T/);
  expect(stateOf(started.pid!)).not.toMatch(/^T/);
});

macTest("stopping the coding engine stops the server and the engine under it, even while chat has them paused, and releases its memory", async () => {
  installFakeSplash(); installRecords();
  const started = await getProcess("coding");
  const { pid, childPid } = report();
  started.pausable!.pause();
  await stopRole("coding");
  await until(() => !isAlive(pid) && !isAlive(childPid));
  expect(isAlive(pid)).toBe(false);
  expect(isAlive(childPid)).toBe(false);
  expect(getGovernorStatus().loaded.some((entry) => entry.id === "coding")).toBe(false);
  expect(getRoleStatus("coding").state).toBe("stopped");
});

macTest("a Splash that starts but does not serve the model is stopped whole, with no orphan, and the request falls back in plain words", async () => {
  installFakeSplash(); installRecords();
  process.env.FAKE_SPLASH_WRONG_NAME = "1";
  // llama-server is not installed in the suite, so the fallback's own refusal is what the person sees; the point here is Splash's tree.
  await expect(getProcess("coding")).rejects.toThrow("No installed llama-server build is available for this machine.");
  const { pid, childPid } = report();
  await until(() => !isAlive(pid) && !isAlive(childPid));
  expect(isAlive(pid)).toBe(false);
  expect(isAlive(childPid)).toBe(false);
  const warning = listHealth().find((item) => item.code === "coding.engine-fallback")!;
  expect(warning.text).toContain("Splash started but does not serve qwen3.8-27b-ud-q4-k-m (it lists something-else), so coding is not using it.");
  expect(warning.text).toContain("Coding is using the slower engine, llama-server, until the coding engine is restarted.");
  expect(codingEngineStatus()).toMatchObject({ engine: "llama-server" });
  expect(codingEngineStatus().engine_reason).toContain("Splash did not start");
  // Nothing of Splash's is still in the governor.
  expect(getGovernorStatus().loaded.some((entry) => entry.id === "coding")).toBe(false);
});

macTest("an engine on the port that is not Splash is refused the same way", async () => {
  installFakeSplash(); installRecords();
  process.env.FAKE_SPLASH_NOT_SPLASH = "1";
  await expect(getProcess("coding")).rejects.toThrow("No installed llama-server build");
  const { pid, childPid } = report();
  await until(() => !isAlive(pid) && !isAlive(childPid));
  expect(isAlive(childPid)).toBe(false);
  expect(listHealth().find((item) => item.code === "coding.engine-fallback")!.text).toContain("did not identify itself as Splash");
});

macTest("a Splash that exits before it listens falls back with the engine's own last words in the warning", async () => {
  installFakeSplash(); installRecords();
  process.env.FAKE_SPLASH_REFUSE = "1";
  await expect(getProcess("coding")).rejects.toThrow("No installed llama-server build");
  const warning = listHealth().find((item) => item.code === "coding.engine-fallback")!;
  expect(warning.text).toContain("Engine exited before becoming healthy (code 3)");
  expect(warning.text).toContain("the model could not be assembled");
});

macTest("a Splash the governor cannot admit leaves llama-server to try, without holding it against Splash", async () => {
  installFakeSplash(); installRecords();
  // 24 GB of memory: the estimate (23 GB) plus the p128 margin does not fit.
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 24 * GB, freeMemoryBytes: 20 * GB, tier: "p128" });
  await expect(getProcess("coding")).rejects.toThrow();
  expect(existsSync(join(splashTmpDir(), "fake-splash.json"))).toBe(false);
  const warning = listHealth().find((item) => item.code === "coding.engine-fallback")!;
  expect(warning.text).toContain("for this request");
  // A memory refusal is not a broken Splash.
  expect(codingEngineStatus().engine).toBe("splash");
});

macTest("the estimate the governor admitted Splash on is the weights, the draft and the window, and the log says it is an estimate", async () => {
  installFakeSplash(); installRecords();
  await getProcess("coding");
  const item = getGovernorStatus().loaded.find((entry) => entry.id === "coding")!;
  // No process reading under the suite's scripted memory reader, so the admitted figure is still the estimate.
  expect(item.peakBytes).toBe(23_012_060_594);
  expect(item.measured).toBe(false);
});
