// ISOLATION-01: chat and voice always win over heavy jobs. The gate stops the
// worker of the running job (SIGSTOP) while a chat, transcription or speech
// request is in flight, plus a short tail, and continues it (SIGCONT)
// afterwards. Hermetic: the workers here are `sleep` children and a small bun
// script that does real CPU work, never a model or a GPU. The state letter is
// read from `ps`: T is stopped.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/app";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly } from "@/lib/governor";
import { endWithStream, heavyGate, isInteractiveRole, PausableProcess, recoverPausedWorkers, setProtectedPidProvider } from "@/lib/heavyGate";
import { __resetJobsForTests, cancelJob, getJob, registerJobRunner, submitJob, waitForJob, PAUSED_FOR_CHAT, updateJob } from "@/lib/jobs";
import { clearModelsForTests } from "@/lib/modelStore";
import { resetSupervisorForTests, scriptedProcess, setSupervisorFactoryForTests } from "@/lib/supervisor";
import { dataDir } from "@/lib/paths";
import { PAUSED_LABEL } from "@/lib/genProgress";
import { registerVideoJobs, stashClip, videoTracker, VIDEO_JOB_KIND } from "@/video/jobs";
import { videoGen, workerHandle, type VideoGenDeps } from "@/video/videoGen";

const GB = 1_073_741_824;
const children: Array<{ pid: number; kill(signal?: number | NodeJS.Signals): void }> = [];

function state(pid: number): string {
  return Bun.spawnSync(["ps", "-o", "state=", "-p", String(pid)], { stdout: "pipe" }).stdout.toString().trim().slice(0, 1);
}
async function until(condition: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (condition()) return true; await Bun.sleep(10); }
  return condition();
}
function sleeper(): { pid: number; kill(signal?: number | NodeJS.Signals): void; exited: Promise<number> } {
  const child = Bun.spawn(["sleep", "120"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  children.push(child);
  return child;
}
const isStopped = (pid: number) => state(pid) === "T";

beforeEach(() => {
  heavyGate.reset();
  process.env.STACK_ISOLATION_TAIL_MS = "120";
  setProtectedPidProvider(() => []);
  __resetJobsForTests();
  __resetGovernorForTests();
  rmSync(join(dataDir, "isolation-paused.json"), { force: true });
});
afterEach(() => {
  heavyGate.reset();
  for (const key of ["STACK_ISOLATION", "STACK_ISOLATION_TAIL_MS", "STACK_ISOLATION_MAX_PAUSE_MS", "STACK_ISOLATION_FORCED_RUN_MS", "STACK_ISOLATION_MAX_AGE_MS", "VIDEO_DEADLINE_MS"]) delete process.env[key];
  for (const child of children.splice(0)) { try { child.kill("SIGCONT"); child.kill("SIGKILL"); } catch { /* gone */ } }
  videoGen.useDeps(null);
  setSupervisorFactoryForTests(null); resetSupervisorForTests(); clearModelsForTests();
  __resetJobsForTests(); __resetGovernorForTests();
});

test("only the turn pipeline and voice are interactive", () => {
  for (const role of ["chat", "coding", "vision", "router", "stt", "tts"]) expect(isInteractiveRole(role)).toBe(true);
  for (const role of ["judge", "embed", "rerank", "wakeword", "image", "video", "music"]) expect(isInteractiveRole(role)).toBe(false);
});

test("a chat request stops the running worker and the tail after it lets it continue", async () => {
  const child = sleeper();
  const lease = heavyGate.attach({ role: "video", jobId: "job-a", worker: new PausableProcess(child.pid, child.exited) });
  expect(isStopped(child.pid)).toBe(false);
  const end = heavyGate.begin("chat");
  expect(isStopped(child.pid)).toBe(true);
  await Bun.sleep(250);
  expect(isStopped(child.pid)).toBe(true); // still in flight
  end();
  expect(isStopped(child.pid)).toBe(true); // inside the tail
  expect(await until(() => !isStopped(child.pid))).toBe(true);
  const status = heavyGate.status();
  expect(status.pauses).toBe(1); expect(status.resumes).toBe(1); expect(status.paused_now).toBe(0); expect(status.interactive_in_flight).toBe(0);
  expect(status.paused_seconds).toBeGreaterThan(0.3);
  lease.detach();
});

test("overlapping chats keep it stopped until the last one ends, and a request inside the tail does not flap it", async () => {
  const child = sleeper();
  heavyGate.attach({ role: "image", jobId: "job-b", worker: new PausableProcess(child.pid, child.exited) });
  const first = heavyGate.begin("chat");
  const second = heavyGate.begin("tts");
  first();
  first(); // ending twice changes nothing
  await Bun.sleep(300);
  expect(isStopped(child.pid)).toBe(true);
  second();
  await Bun.sleep(60); // inside the 120 ms tail
  expect(isStopped(child.pid)).toBe(true);
  const third = heavyGate.begin("stt");
  await Bun.sleep(250);
  expect(isStopped(child.pid)).toBe(true);
  third();
  expect(await until(() => !isStopped(child.pid))).toBe(true);
  expect(heavyGate.status().pauses).toBe(1); // one pause across all four requests
  expect(heavyGate.status().resumes).toBe(1);
});

test("background requests never pause a job", async () => {
  const child = sleeper();
  heavyGate.attach({ role: "music", jobId: "job-c", worker: new PausableProcess(child.pid, child.exited) });
  const ends = ["judge", "embed", "rerank", "image", "video"].map((role) => heavyGate.begin(role));
  await Bun.sleep(100);
  expect(isStopped(child.pid)).toBe(false);
  expect(heavyGate.status().interactive_in_flight).toBe(0);
  expect(heavyGate.status().pauses).toBe(0);
  ends.forEach((end) => end());
});

test("a job that starts while a chat is in flight is stopped at once", async () => {
  const end = heavyGate.begin("chat");
  const child = sleeper();
  heavyGate.attach({ role: "video", jobId: "job-d", worker: new PausableProcess(child.pid, child.exited) });
  expect(isStopped(child.pid)).toBe(true);
  end();
  expect(await until(() => !isStopped(child.pid))).toBe(true);
});

test("the worker dying while paused is clean: nothing throws, nothing is signalled later", async () => {
  const child = sleeper();
  const lease = heavyGate.attach({ role: "video", jobId: "job-e", worker: new PausableProcess(child.pid, child.exited) });
  const end = heavyGate.begin("chat");
  expect(isStopped(child.pid)).toBe(true);
  child.kill("SIGKILL");
  await child.exited;
  end();
  await Bun.sleep(250); // the tail fires on a dead process
  lease.detach();
  expect(heavyGate.status().paused_now).toBe(0);
  expect(existsSync(join(dataDir, "isolation-paused.json"))).toBe(false);
});

test("ending the job while paused (finish, cancel, kill) continues the worker first", async () => {
  const child = sleeper();
  const worker = new PausableProcess(child.pid, child.exited);
  const lease = heavyGate.attach({ role: "image", jobId: "job-f", worker });
  const end = heavyGate.begin("chat");
  expect(isStopped(child.pid)).toBe(true);
  lease.detach();
  expect(isStopped(child.pid)).toBe(false);
  // A kill goes through the same door: a stopped process holds its SIGTERM until it runs again.
  const other = sleeper();
  const stopped = new PausableProcess(other.pid, other.exited);
  heavyGate.attach({ role: "video", jobId: "job-f2", worker: stopped });
  expect(isStopped(other.pid)).toBe(true);
  stopped.killAfterResume(() => other.kill("SIGTERM"));
  expect(await Promise.race([other.exited, Bun.sleep(2000).then(() => -1)])).not.toBe(-1);
  end();
});

test("a pause never lasts past the maximum: the watchdog continues the worker, logs it, and the worker runs a while before it can be stopped again", async () => {
  process.env.STACK_ISOLATION_MAX_PAUSE_MS = "200";
  process.env.STACK_ISOLATION_FORCED_RUN_MS = "300";
  const child = sleeper();
  heavyGate.attach({ role: "video", jobId: "job-g", worker: new PausableProcess(child.pid, child.exited) });
  const end = heavyGate.begin("tts"); // a voice session that never stops
  expect(isStopped(child.pid)).toBe(true);
  expect(await until(() => !isStopped(child.pid), 1500)).toBe(true);
  expect(heavyGate.status().forced_resumes).toBe(1);
  await Bun.sleep(150);
  expect(isStopped(child.pid)).toBe(false); // inside its forced run
  expect(await until(() => isStopped(child.pid), 1500)).toBe(true); // chat is still going: stopped again
  end();
  expect(await until(() => !isStopped(child.pid))).toBe(true);
  const log = readFileSync(join(dataDir, "logs", "stack.log"), "utf8");
  expect(log).toContain('"event":"isolation.resume_forced"');
  expect(log).toContain('"event":"isolation.paused"');
  expect(log).toContain('"event":"isolation.resumed"');
});

test("a request that never ended expires, so a leaked count cannot hold a job forever", async () => {
  process.env.STACK_ISOLATION_MAX_AGE_MS = "150";
  const child = sleeper();
  heavyGate.attach({ role: "video", jobId: "job-h", worker: new PausableProcess(child.pid, child.exited) });
  heavyGate.begin("chat"); // never ended
  expect(isStopped(child.pid)).toBe(true);
  await Bun.sleep(250);
  expect(heavyGate.status().interactive_in_flight).toBe(0);
});

test("the Stack's own pid and every engine the supervisor runs are never stopped", async () => {
  const engine = sleeper();
  setProtectedPidProvider(() => [engine.pid]);
  const stoppedEngine = new PausableProcess(engine.pid, engine.exited);
  expect(stoppedEngine.pause()).toBe(false);
  expect(new PausableProcess(process.pid).pause()).toBe(false);
  expect(new PausableProcess(1).pause()).toBe(false);
  expect(new PausableProcess(null).pause()).toBe(false);
  heavyGate.attach({ role: "video", jobId: "job-i", worker: stoppedEngine });
  const end = heavyGate.begin("chat");
  expect(isStopped(engine.pid)).toBe(false);
  end();
});

test("STACK_ISOLATION=off turns the pause off", async () => {
  process.env.STACK_ISOLATION = "off";
  const child = sleeper();
  heavyGate.attach({ role: "video", jobId: "job-j", worker: new PausableProcess(child.pid, child.exited) });
  const end = heavyGate.begin("chat");
  await Bun.sleep(80);
  expect(isStopped(child.pid)).toBe(false);
  end();
});

test("the worker's deadline does not run while it is stopped", async () => {
  const child = sleeper();
  const worker = new PausableProcess(child.pid, child.exited);
  let fired = 0;
  worker.deadline(300, () => { fired += 1; });
  await Bun.sleep(100);
  expect(worker.pause()).toBe(true);
  await Bun.sleep(500);
  expect(fired).toBe(0);
  worker.resume();
  await Bun.sleep(100);
  expect(fired).toBe(0); // about 200 ms of its 300 are left
  expect(await until(() => fired === 1, 1000)).toBe(true);
  const cleared = worker.deadline(100, () => { fired += 10; });
  cleared.clear();
  await Bun.sleep(200);
  expect(fired).toBe(1);
});

test("a Stack killed while a worker was stopped continues it at its next start", async () => {
  const child = sleeper();
  heavyGate.attach({ role: "video", jobId: "job-k", worker: new PausableProcess(child.pid, child.exited) });
  const end = heavyGate.begin("chat");
  expect(isStopped(child.pid)).toBe(true);
  const file = join(dataDir, "isolation-paused.json");
  expect(JSON.parse(readFileSync(file, "utf8"))[0].pid).toBe(child.pid);
  // The old Stack is gone (as far as the file goes); a new one starts.
  heavyGate.reset();
  expect(isStopped(child.pid)).toBe(false); // reset itself continues; put it back as the dead Stack left it
  process.kill(child.pid, "SIGSTOP");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify([{ pid: child.pid, command: Bun.spawnSync(["ps", "-o", "command=", "-p", String(child.pid)]).stdout.toString().trim() }]));
  expect(isStopped(child.pid)).toBe(true);
  expect(recoverPausedWorkers()).toBe(1);
  expect(isStopped(child.pid)).toBe(false);
  expect(existsSync(file)).toBe(false);
  end();
  // A pid that is now some other command is left alone.
  process.kill(child.pid, "SIGSTOP");
  writeFileSync(file, JSON.stringify([{ pid: child.pid, command: "not-the-same-command" }]));
  expect(recoverPausedWorkers()).toBe(0);
  expect(isStopped(child.pid)).toBe(true);
  process.kill(child.pid, "SIGCONT");
});

test("a stream that finishes, fails or is cancelled ends its request", async () => {
  const make = (action: "read" | "cancel" | "error"): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
    pull(controller) { if (action === "error") controller.error(new Error("engine went away")); else { controller.enqueue(new Uint8Array([1])); if (action === "read") controller.close(); } },
  });
  for (const action of ["read", "cancel", "error"] as const) {
    const end = heavyGate.begin("chat");
    expect(heavyGate.status().interactive_in_flight).toBe(1);
    const wrapped = endWithStream(make(action), end)!;
    const reader = wrapped.getReader();
    if (action === "cancel") { await reader.read(); await reader.cancel(); } else { try { while (!(await reader.read()).done) { /* drain */ } } catch { /* the failure */ } }
    expect(heavyGate.status().interactive_in_flight).toBe(0);
  }
  const end = heavyGate.begin("chat");
  expect(endWithStream(null, end)).toBeNull();
  expect(heavyGate.status().interactive_in_flight).toBe(0);
});

// ---- through the routes: the Stack sees its own requests ----

function slowEngine(release: Promise<void>, seen: { requests: number }) {
  setSupervisorFactoryForTests(async (role) => {
    const base = scriptedProcess(role);
    return scriptedProcess(role, {
      client: {
        ...base.client,
        async request(path, body, signal) { seen.requests += 1; await release; return base.client.request(path, body, signal); },
        async stream(path, body, signal) { seen.requests += 1; await release; return base.client.stream!(path, body, signal); },
      },
    });
  });
}
const chat = (model: string, extra: Record<string, unknown> = {}) => app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }], ...extra }) });

test("a chat request through the route stops the job while it is in flight and not after the tail", async () => {
  const child = sleeper();
  heavyGate.attach({ role: "video", jobId: "job-l", worker: new PausableProcess(child.pid, child.exited) });
  let open!: () => void;
  const release = new Promise<void>((resolve) => { open = resolve; });
  const seen = { requests: 0 };
  slowEngine(release, seen);
  const pending = chat("chat");
  expect(await until(() => isStopped(child.pid))).toBe(true);
  open();
  expect((await pending).status).toBe(200);
  expect(await until(() => !isStopped(child.pid))).toBe(true);
});

test("a streamed chat holds the pause until its last byte is read", async () => {
  const child = sleeper();
  heavyGate.attach({ role: "video", jobId: "job-m", worker: new PausableProcess(child.pid, child.exited) });
  slowEngine(Promise.resolve(), { requests: 0 });
  const response = await chat("chat", { stream: true });
  expect(isStopped(child.pid)).toBe(true);
  await Bun.sleep(250); // the body is not read yet: the request is still in flight
  expect(isStopped(child.pid)).toBe(true);
  await response.text();
  expect(await until(() => !isStopped(child.pid))).toBe(true);
});

test("the memory judge's requests, embeddings and token counts do not pause a job", async () => {
  const child = sleeper();
  heavyGate.attach({ role: "video", jobId: "job-n", worker: new PausableProcess(child.pid, child.exited) });
  setSupervisorFactoryForTests(async (role) => scriptedProcess(role));
  expect((await chat("judge")).status).toBe(200);
  const embeddings = await app.request("/v1/embeddings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "embed", input: "hi" }) });
  expect(embeddings.status).toBe(200);
  const tokens = await app.request("/v1/chat/completions/tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "chat", messages: [{ role: "user", content: "hi there" }] }) });
  expect([200, 404, 501]).toContain(tokens.status);
  expect(isStopped(child.pid)).toBe(false);
  expect(heavyGate.status().pauses).toBe(0);
});

test("the memory route reports the isolation counters", async () => {
  const response = await app.request("/stack/v1/memory");
  expect(response.status).toBe(200);
  const body = await response.json() as { isolation: { enabled: boolean; pauses: number; paused_now: number } };
  expect(body.isolation.enabled).toBe(true);
  expect(body.isolation.paused_now).toBe(0);
});

// ---- the job: card, progress, deadline, cancel ----

test("the job card says why it waits and goes back to its stage; a stage that arrives meanwhile is kept for the resume", async () => {
  const child = sleeper();
  let release!: () => void;
  const finish = new Promise<void>((resolve) => { release = resolve; });
  registerJobRunner("heavy_test", async (job, _signal, progress) => {
    const lease = heavyGate.attach({ role: "video", jobId: job.id, worker: new PausableProcess(child.pid, child.exited) });
    try { progress({ status: "rendering", percent: 20 }); await finish; progress({ status: "decoding" }); return { ok: true }; } finally { lease.detach(); }
  }, { generator: { role: "video", memory: () => ({ requestedBytes: GB }) } });
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB, tier: "p128" });
  const submitted = submitJob({ kind: "heavy_test", role: "video" });
  if (!("job" in submitted)) throw new Error("refused");
  const id = submitted.job.id;
  expect(await until(() => getJob(id)?.status === "rendering")).toBe(true);
  const end = heavyGate.begin("chat");
  expect(getJob(id)!.status).toBe(PAUSED_FOR_CHAT);
  expect(getJob(id)!.state).toBe("running"); // paused is a stage, not a stall or a failure
  updateJob(id, { status: "loading" }); // a stage that was already on its way
  expect(getJob(id)!.status).toBe(PAUSED_FOR_CHAT);
  end();
  expect(await until(() => getJob(id)!.status === "loading")).toBe(true);
  expect(isStopped(child.pid)).toBe(false);
  release();
  const done = await waitForJob(id, 3000);
  expect(done?.state).toBe("done");
});

test("cancelling a paused job continues the worker and ends the job as cancelled", async () => {
  const child = sleeper();
  const worker = new PausableProcess(child.pid, child.exited);
  registerJobRunner("heavy_cancel", async (job, signal) => {
    const lease = heavyGate.attach({ role: "image", jobId: job.id, worker });
    try { await new Promise<void>((_, reject) => signal.addEventListener("abort", () => { worker.killAfterResume(() => child.kill("SIGTERM")); reject(new Error("aborted")); }, { once: true })); } finally { lease.detach(); }
  }, { generator: { role: "image", memory: () => ({ requestedBytes: GB }) } });
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB, tier: "p128" });
  const submitted = submitJob({ kind: "heavy_cancel", role: "image" });
  if (!("job" in submitted)) throw new Error("refused");
  const id = submitted.job.id;
  expect(await until(() => getJob(id)?.state === "running" && getJob(id)?.status === "starting")).toBe(true);
  const end = heavyGate.begin("chat");
  expect(isStopped(child.pid)).toBe(true);
  expect(cancelJob(id)?.state).toBe("cancelled");
  expect(await Promise.race([child.exited, Bun.sleep(2000).then(() => -1)])).not.toBe(-1); // it ran again, took the signal and left
  end();
  expect(getJob(id)?.state).toBe("cancelled");
});

/** A worker that does real CPU work (a stopped process makes no progress), speaking the video worker's line protocol. */
const WORKER_SCRIPT = `
const fs = require("fs");
process.stdout.write(JSON.stringify({ ready: true }) + "\\n");
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
    process.stdout.write(JSON.stringify({ id: request.id, event: "phase", phase: "decoding", percent: 10 }) + "\\n");
    process.stdout.write(JSON.stringify({ id: request.id, event: "stage", stage: "frames", n: 1, of: 10 }) + "\\n");
    const start = cpu();
    while (cpu() - start < Number(process.env.TEST_WORK_MS)) { /* work */ }
    fs.writeFileSync(request.output, "MP4"); fs.writeFileSync(request.poster, "JPG");
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, width: request.width, height: request.height, frames: request.num_frames, fps: 24, seed: request.seed, ms: 1, peak_bytes: null }) + "\\n");
  }
});
`;

test("a real clip job: the deadline and the estimate leave the paused time out, and the clip finishes", async () => {
  process.env.VIDEO_DEADLINE_MS = "2500";
  process.env.STACK_ISOLATION_TAIL_MS = "100";
  const script = join(dataDir, "heavy-test-worker.js");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(script, WORKER_SCRIPT);
  let workerPid = 0;
  const deps: VideoGenDeps = {
    supported: () => true,
    ensureEnvironment: async () => {},
    paths: () => ({ modelDir: "/models/video", tokenizerDir: "/models/tok" }),
    spawn: async () => {
      const child = Bun.spawn([process.execPath, script], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, TEST_WORK_MS: "1200" } });
      workerPid = child.pid; children.push(child);
      return workerHandle(child);
    },
  };
  videoGen.useDeps(deps);
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB, tier: "p128" });
  registerVideoJobs();
  stashClip("tok-1", { prompt: "a quiet harbour", negativePrompt: null, image: null, width: 832, height: 480, frames: 121, seed: 1, loras: [], loraIds: [], preview: false });
  const submitted = submitJob({ kind: VIDEO_JOB_KIND, role: "video", input: { token: "tok-1" } });
  if (!("job" in submitted)) throw new Error("refused");
  const id = submitted.job.id;
  expect(await until(() => workerPid > 0 && getJob(id)?.status === "decoding", 5000)).toBe(true);
  // A chat that lasts longer than the whole deadline, while the clip is being made.
  const end = heavyGate.begin("chat");
  expect(await until(() => getJob(id)?.status === PAUSED_FOR_CHAT, 2000)).toBe(true);
  expect(isStopped(workerPid)).toBe(true);
  const route = await (await app.request(`/v1/videos/generations/${id}`)).json() as { stage_label: string | null; eta_seconds: number | null; state: string };
  expect(route.stage_label).toBe(PAUSED_LABEL); // the existing job-card field, no new surface
  expect(route.eta_seconds).toBeNull();
  expect(route.state).toBe("running");
  const tracker = videoTracker(id)!;
  const snap = tracker.snapshot();
  expect(snap.stage_label).toBe(PAUSED_LABEL);
  expect(snap.eta_seconds).toBeNull();
  const before = tracker.snapshot().fraction;
  await Bun.sleep(3000); // longer than the 2.5 s deadline
  expect(getJob(id)?.state).toBe("running"); // not killed as hung, not marked stalled or failed
  expect(tracker.snapshot().fraction).toBe(before);
  end();
  const done = await waitForJob(id, 15_000);
  expect(done?.state).toBe("done");
  const resumed = tracker.snapshot();
  expect(resumed.stage_label).not.toBe(PAUSED_LABEL);
  expect(isStopped(workerPid)).toBe(false);
}, 30_000);
