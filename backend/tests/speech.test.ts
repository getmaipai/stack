// STACK-94b: the stt role. The bundled clip decodes and transcribes
// through the worker's server with scripted engines, the live session
// endpoints an utterance and applies the two Moonshine rules, the Stack's
// route forwards the spec's form with identity headers, the session
// proxy passes frames both ways, and a model package installs as a
// directory. Nothing here loads the native runtime.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { serveOptions } from "@/daemon";
import { __resetHealthForTests } from "@/lib/health";
import { clearModelsForTests, installCatalogModel, packageDirectoryName, removeModel, upsertModel } from "@/lib/modelStore";
import { bundledClipBase64, componentModel, probeReplyOk, probeRequest, resetSupervisorForTests, restartRole, scriptedProcess, selectedModel, setSupervisorFactoryForTests, speechWorkerCommand } from "@/lib/supervisor";
import { decodeWave, frameToSamples, resampleLinear, rms, toRecognizerRate } from "@/speech/audio";
import { isLikelySpeech, SttSession, type Transcriber, type VoiceDetector } from "@/speech/session";
import { SESSION_PATH, startSpeechServer, TRANSCRIBE_PATH } from "@/speech/server";
import { parseWorkerArgs } from "@/speech/worker";
import { SttWireEvent } from "@/spec/ts/stt-wire-event";
import { __resetSettingsForTests } from "@/settings";
import { modelsDir } from "@/lib/paths";

const SENTENCE = "Clover, the kitchen light is on.";
const clipPath = join(import.meta.dir, "..", "src", "speech", "fixtures", "clover-two-seconds.wav");
const clip = decodeWave(new Uint8Array(readFileSync(clipPath)));

beforeEach(() => { __resetHealthForTests(); __resetSettingsForTests(); clearModelsForTests(); setSupervisorFactoryForTests(async (role) => scriptedProcess(role)); });
afterEach(() => { setSupervisorFactoryForTests(null); resetSupervisorForTests(); clearModelsForTests(); });

// ---- audio ----------------------------------------------------------------

test("the bundled clip is 16 kHz mono, about two seconds, and carries speech", () => {
  expect(clip.sampleRate).toBe(16_000);
  expect(clip.samples.length / clip.sampleRate).toBeGreaterThan(1.9);
  expect(clip.samples.length / clip.sampleRate).toBeLessThan(2.5);
  expect(rms(clip.samples)).toBeGreaterThan(0.01);
});

function wav(samples: Int16Array, sampleRate: number, channels: number, leading: Uint8Array = new Uint8Array(0)): Uint8Array {
  const data = new Uint8Array(samples.buffer);
  const out = new Uint8Array(44 + leading.length + data.length);
  const view = new DataView(out.buffer);
  const tag = (offset: number, text: string) => { for (let index = 0; index < 4; index += 1) out[offset + index] = text.charCodeAt(index); };
  tag(0, "RIFF"); view.setUint32(4, out.length - 8, true); tag(8, "WAVE");
  tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  out.set(leading, 36);
  const dataAt = 36 + leading.length;
  tag(dataAt, "data"); view.setUint32(dataAt + 4, data.length, true);
  out.set(data, dataAt + 8);
  return out;
}

test("a stereo 44.1 kHz WAV with a LIST chunk before its data decodes to mono and resamples to 16 kHz", () => {
  const frames = 44_100;
  const samples = new Int16Array(frames * 2);
  for (let frame = 0; frame < frames; frame += 1) { samples[frame * 2] = 16_000; samples[frame * 2 + 1] = -16_000; }
  const list = new Uint8Array(12); list.set([76, 73, 83, 84, 4, 0, 0, 0, 65, 66, 67, 68]);
  const decoded = decodeWave(wav(samples, 44_100, 2, list));
  expect(decoded.sampleRate).toBe(44_100);
  expect(decoded.samples.length).toBe(frames);
  expect(decoded.samples[10]).toBeCloseTo(0, 5);
  expect(toRecognizerRate(decoded).length).toBe(16_000);
  expect(() => decodeWave(new Uint8Array([1, 2, 3]))).toThrow(/RIFF/);
});

test("a binary session frame is little-endian float32 samples with no envelope", () => {
  const samples = new Float32Array([0.25, -0.5, 1]);
  const bytes = new Uint8Array(samples.buffer.slice(0));
  expect(Array.from(frameToSamples(bytes))).toEqual([0.25, -0.5, 1]);
  expect(frameToSamples(bytes.subarray(0, 9)).length).toBe(2);
  expect(resampleLinear(new Float32Array([0, 1]), 2, 4).length).toBe(4);
});

// ---- the session ----------------------------------------------------------

/** Voiced when the frame has energy: the room is silent or it is not. */
const energyDetector = (): VoiceDetector => ({ push: (samples) => rms(samples) > 0.01, reset() {} });
/** Frames the clip the way a browser sends it, with silence around it. */
function* clipFrames(silenceBeforeS: number, silenceAfterS: number, frame = 512): Generator<Float32Array> {
  const before = new Float32Array(Math.round(silenceBeforeS * 16_000));
  const after = new Float32Array(Math.round(silenceAfterS * 16_000));
  const all = new Float32Array(before.length + clip.samples.length + after.length);
  all.set(clip.samples, before.length);
  for (let offset = 0; offset < all.length; offset += frame) yield all.subarray(offset, Math.min(offset + frame, all.length));
}
function scriptedTranscriber(answers: (samples: Float32Array) => string): Transcriber & { calls: number[] } {
  const calls: number[] = [];
  return { calls, async transcribe(samples) { calls.push(samples.length); return answers(samples); } };
}

test("the live session opens on voice, sends partials and closes on silence with the final transcript, every event a spec SttWireEvent", async () => {
  const events: SttWireEvent[] = [];
  const transcriber = scriptedTranscriber(() => SENTENCE);
  const session = new SttSession({ transcriber, detector: energyDetector(), send: (event) => events.push(SttWireEvent.parse(event)), config: { silenceTimeoutS: 0.5, partialIntervalS: 0.5 } });
  for (const frame of clipFrames(0.5, 1)) session.pushPcm(frame);
  await session.settle();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(events[0]).toMatchObject({ t: "vad", speaking: true });
  expect(events.some((event) => event.t === "partial" && event.v === SENTENCE)).toBe(true);
  expect(events.at(-2)).toMatchObject({ t: "vad", speaking: false });
  expect(events.at(-1)).toEqual({ t: "final", v: SENTENCE });
  expect(transcriber.calls.length).toBeGreaterThanOrEqual(1);
});

test("Moonshine's silent-head rule: an empty decode retries once from the voiced onset with the pre-roll dropped", async () => {
  const events: SttWireEvent[] = [];
  // Empty for a buffer whose head is dead air, the way Moonshine tiny answers.
  const transcriber = scriptedTranscriber((samples) => rms(samples.subarray(0, 2_000)) < 0.001 ? "" : SENTENCE);
  const session = new SttSession({ transcriber, detector: energyDetector(), send: (event) => events.push(event), config: { silenceTimeoutS: 0.5, partialIntervalS: 60 } });
  for (const frame of clipFrames(1, 1)) session.pushPcm(frame);
  await session.settle();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(events.at(-1)).toEqual({ t: "final", v: SENTENCE });
  // The last decode is the retry, shorter than the one before it by the pre-roll.
  const [full, retry] = transcriber.calls.slice(-2);
  expect(full! - retry!).toBeGreaterThanOrEqual(0.25 * 16_000);
  expect(full! - retry!).toBeLessThanOrEqual(0.35 * 16_000);
});

test("a burst under 0.2 s and an annotation-only transcript are no_speech, and an explicit end flushes the utterance", async () => {
  const events: SttWireEvent[] = [];
  const session = new SttSession({ transcriber: scriptedTranscriber(() => "[BLANK_AUDIO]"), detector: energyDetector(), send: (event) => events.push(event), config: { silenceTimeoutS: 0.3 } });
  const burst = new Float32Array(1_600).fill(0.2);
  session.pushPcm(burst);
  session.pushPcm(new Float32Array(8_000));
  await session.settle();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(events.at(-1)).toEqual({ t: "no_speech" });
  events.length = 0;
  for (const frame of clipFrames(0, 0)) session.pushPcm(frame);
  session.end();
  await session.settle();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(events.at(-1)).toEqual({ t: "no_speech" });
  expect(isLikelySpeech("(typing)")).toBe(false);
  expect(isLikelySpeech(SENTENCE)).toBe(true);
});

// ---- the worker's server ---------------------------------------------------

const speechServer = startSpeechServer({ port: 0, build: "sherpa-onnx-node-test", modelPath: "/models/sherpa-onnx-moonshine-tiny-en-int8", transcriber: scriptedTranscriber((samples) => samples.length > 16_000 ? SENTENCE : ""), detector: energyDetector, session: { silenceTimeoutS: 0.3, partialIntervalS: 60 } });
const speechBase = `http://127.0.0.1:${speechServer.port}`;
afterAll(() => speechServer.stop(true));

test("the worker wears llama-server's identity shape and transcribes the clip from the spec's form and from the probe's JSON", async () => {
  expect(await (await fetch(`${speechBase}/health`)).json()).toEqual({ status: "ok" });
  expect(await (await fetch(`${speechBase}/props`)).json()).toEqual({ build_info: "sherpa-onnx-node-test", model_path: "/models/sherpa-onnx-moonshine-tiny-en-int8" });
  const form = new FormData();
  form.append("file", new Blob([readFileSync(clipPath)], { type: "audio/wav" }), "clip.wav");
  expect(await (await fetch(`${speechBase}${TRANSCRIBE_PATH}`, { method: "POST", body: form })).json()).toEqual({ text: SENTENCE });
  const probe = probeRequest("stt");
  expect(probe.path).toBe(TRANSCRIBE_PATH);
  const reply = await fetch(`${speechBase}${probe.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(probe.body) });
  const body = await reply.json();
  expect(body).toEqual({ text: SENTENCE });
  expect(probeReplyOk("stt", { status: 200, body })).toBe(true);
  expect(probeReplyOk("stt", { status: 200, body: { text: "" } })).toBe(false);
  expect((await fetch(`${speechBase}${TRANSCRIBE_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ audio_base64: Buffer.from("not a wav").toString("base64") }) })).status).toBe(400);
});

async function runSession(url: string): Promise<SttWireEvent[]> {
  const events: SttWireEvent[] = [];
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("The session did not open.")); });
  const done = new Promise<void>((resolve) => { socket.onclose = () => resolve(); });
  socket.onmessage = (message) => {
    const event = SttWireEvent.parse(JSON.parse(String(message.data)));
    events.push(event);
    if (event.t === "final" || event.t === "no_speech" || event.t === "error") socket.close();
  };
  for (const frame of clipFrames(0.2, 0)) socket.send(frame.slice().buffer);
  socket.send(JSON.stringify({ t: "end" }));
  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  return events;
}

test("the session endpoint says ready, reports voice, and ends the utterance on the client's end frame", async () => {
  const events = await runSession(`ws://127.0.0.1:${speechServer.port}${SESSION_PATH}`);
  expect(events[0]).toEqual({ t: "ready" });
  expect(events[1]).toMatchObject({ t: "vad", speaking: true });
  expect(events.at(-1)).toEqual({ t: "final", v: SENTENCE });
});

// ---- the Stack's routes -----------------------------------------------------

test("POST /v1/audio/transcriptions takes the spec's form and answers the transcript with the identity headers; no file is a 400", async () => {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(clipPath)], { type: "audio/wav" }), "clip.wav");
  const response = await app.request("/v1/audio/transcriptions", { method: "POST", body: form });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ text: SENTENCE });
  expect(response.headers.get("x-maipai-engine")).toBe("stub scripted");
  expect(response.headers.get("x-maipai-model")).toBe("scripted-stt");
  const empty = new FormData();
  empty.append("model", "stt");
  expect((await app.request("/v1/audio/transcriptions", { method: "POST", body: empty })).status).toBe(400);
  expect(bundledClipBase64().length).toBeGreaterThan(1_000);
});

test("WS /v1/audio/transcriptions/stream passes frames to the stt process and its events back, and releases the process when the session ends", async () => {
  let released = false;
  setSupervisorFactoryForTests(async (role) => {
    const scripted = scriptedProcess(role);
    return { ...scripted, client: { ...scripted.client, baseUrl: speechBase }, stop: async () => { released = true; } };
  });
  const stack = Bun.serve({ ...serveOptions(), port: 0 });
  try {
    const events = await runSession(`ws://127.0.0.1:${stack.port}${SESSION_PATH}`);
    expect(events[0]).toEqual({ t: "ready" });
    expect(events.at(-1)).toEqual({ t: "final", v: SENTENCE });
    const status = await (await app.request("/stack/v1/roles")).json() as { roles: Array<{ id: string; state: { state: string } }> };
    expect(status.roles.find((role) => role.id === "stt")?.state.state).toBe("ready");
  } finally {
    stack.stop(true);
  }
  expect(released).toBe(false);
});

test("a session with no stt engine tells the client why and closes", async () => {
  setSupervisorFactoryForTests(async () => { throw new Error("No verified and installed stt model is available."); });
  const stack = Bun.serve({ ...serveOptions(), port: 0 });
  try {
    const events = await runSession(`ws://127.0.0.1:${stack.port}${SESSION_PATH}`);
    expect(events.at(-1)).toMatchObject({ t: "error", v: expect.stringContaining("stt model") });
  } finally {
    stack.stop(true);
  }
});

// ---- the worker's launch and the store ---------------------------------------

test("the worker command differs under bun run and the compiled binary, and the args parse", () => {
  const args = { role: "stt" as const, port: 8791, modelPath: "/m/pkg", vadPath: "/m/silero_vad.onnx", threads: 2 };
  // Uncompiled (`bun run`): execPath is bun itself, the entry file goes
  // in between - unchanged from before getmaipai/stack#8's fix.
  expect(speechWorkerCommand(args, { execPath: "/opt/bun/bin/bun", main: "/src/backend/src/index.ts", isCompiled: false })).toEqual(["/opt/bun/bin/bun", "/src/backend/src/index.ts", "speech-worker", "--role", "stt", "--port", "8791", "--model", "/m/pkg", "--vad", "/m/silero_vad.onnx", "--threads", "2"]);
  // Compiled: a real bun, against the vendored source tree beside the
  // binary, never a re-invocation of the compiled binary itself (the
  // exact shape getmaipai/stack#8 breaks).
  expect(speechWorkerCommand(args, { execPath: "/opt/maipai/stack/maipai-stack", main: "/$bunfs/root/maipai-stack", isCompiled: true, bunBin: "/opt/maipai/bun" })).toEqual(["/opt/maipai/bun", "/opt/maipai/stack/backend-src/src/index.ts", "speech-worker", "--role", "stt", "--port", "8791", "--model", "/m/pkg", "--vad", "/m/silero_vad.onnx", "--threads", "2"]);
  // Compiled with no bun named: a clear error, not a silent fall-through
  // to the broken re-invocation.
  expect(() => speechWorkerCommand(args, { execPath: "/opt/maipai/stack/maipai-stack", main: "/$bunfs/root/maipai-stack", isCompiled: true })).toThrow(/STACK_BUN_BIN/);
  expect(parseWorkerArgs(["--role", "stt", "--port", "8791", "--model", "/m/pkg", "--vad", "/m/v.onnx"])).toEqual({ role: "stt", port: 8791, model: "/m/pkg", vad: "/m/v.onnx", threads: 2 });
  expect(() => parseWorkerArgs(["--role", "tts", "--port", "1"])).toThrow(/--role stt/);
  expect(() => parseWorkerArgs(["--role", "stt", "--model", "/m"])).toThrow(/--port/);
});

test("a model package installs as a directory named after its archive, and a component is never the role's selected model", async () => {
  const dir = join(tmpdir(), `maipai-stack-speech-${Date.now()}`);
  mkdirSync(join(dir, "sherpa-onnx-moonshine-tiny-en-int8"), { recursive: true });
  writeFileSync(join(dir, "sherpa-onnx-moonshine-tiny-en-int8", "tokens.txt"), "a\n");
  const archive = join(dir, "sherpa-onnx-moonshine-tiny-en-int8.tar.gz");
  Bun.spawnSync(["tar", "-czf", archive, "-C", dir, "sherpa-onnx-moonshine-tiny-en-int8"]);
  const bytes = readFileSync(archive);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  expect(packageDirectoryName(archive)).toBe("sherpa-onnx-moonshine-tiny-en-int8");
  expect(packageDirectoryName("/m/pkg.tar")).toBe("pkg");
  expect(packageDirectoryName("/m/pkg")).toBe("pkg.extracted");
  const installed = await installCatalogModel(
    { id: "moonshine-test", role: "stt", license: "MIT", revision: sha256, engine: "sherpa-onnx-node", download: { url: "https://catalog.test/pkg.tar.gz", sha256, approx_bytes: bytes.length, archive: true } },
    { destination: join(modelsDir, "moonshine-test", "sherpa-onnx-moonshine-tiny-en-int8.tar.gz"), download: async (_url, destination) => { mkdirSync(join(destination, ".."), { recursive: true }); writeFileSync(destination, bytes); } },
  );
  expect(installed.modelPath).toBe(join(modelsDir, "moonshine-test", "sherpa-onnx-moonshine-tiny-en-int8"));
  expect(existsSync(join(installed.modelPath!, "tokens.txt"))).toBe(true);
  const verified = { source: "catalog" as const, provenance: {}, revision: "r", sha256: "b".repeat(64), licence: "MIT", verifiedAt: new Date().toISOString() };
  upsertModel({ id: "silero-test", roles: ["stt"], ...verified, modelPath: join(dir, "silero_vad.onnx"), engineRequirements: { engine: "sherpa-onnx-node", component: "vad" } });
  expect(selectedModel("stt")?.id).toBe("moonshine-test");
  expect(componentModel("stt", "vad")?.id).toBe("silero-test");
  // Removing the package takes the directory and the archive with it.
  expect(removeModel("moonshine-test")).toBe(true);
  expect(existsSync(installed.modelPath!)).toBe(false);
  expect(existsSync(join(modelsDir, "moonshine-test", "sherpa-onnx-moonshine-tiny-en-int8.tar.gz"))).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("a restart under a live session ends the session from the server side, so the drain never waits on the client", async () => {
  let stopped = 0;
  setSupervisorFactoryForTests(async (role) => {
    const scripted = scriptedProcess(role);
    return { ...scripted, client: { ...scripted.client, baseUrl: speechBase }, stop: async () => { stopped += 1; } };
  });
  const stack = Bun.serve({ ...serveOptions(), port: 0 });
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${stack.port}${SESSION_PATH}`);
    const ready = new Promise<void>((resolve) => { socket.onmessage = (message) => { if (JSON.parse(String(message.data)).t === "ready") resolve(); }; });
    await new Promise<void>((resolve) => { socket.onopen = () => resolve(); });
    await ready;
    const events: SttWireEvent[] = [];
    socket.onmessage = (message) => events.push(SttWireEvent.parse(JSON.parse(String(message.data))));
    const closed = new Promise<string>((resolve) => { socket.onclose = (event) => resolve(event.reason); });
    await Promise.race([restartRole("stt"), new Promise((_, reject) => setTimeout(() => reject(new Error("the restart waited on the session")), 3_000))]);
    expect(await closed).toBe("The stt engine is restarting.");
    expect(events.at(-1)).toEqual({ t: "error", v: "The stt engine is restarting." });
    expect(stopped).toBe(1);
  } finally {
    stack.stop(true);
  }
});

test("the readiness check probes stt with the bundled clip and counts it, never skips it", async () => {
  const { runCheck } = await import("@/lib/readiness");
  const run = await runCheck({ roleIds: ["stt"] });
  expect(run.ok).toBe(true);
  expect(run.results).toEqual([expect.objectContaining({ role: "stt", ok: true })]);
});
