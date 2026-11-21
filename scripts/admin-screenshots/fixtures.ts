// Demo data for the admin page screenshots (scripts/make-admin-screenshots.sh).
//
// The screenshots come from a real scratch Stack (its own data folder and port,
// a real admin account made through the real setup route). A scratch Stack has
// nothing installed and shows this computer's own processes, so the answers that
// would show those are replaced, in the browser only, with the numbers below.
// Settings, the tier recommendation, the model catalog and sign-in are the
// Stack's own. Nothing here is written to the Stack or to disk.
//
// The data is made up: no household, no real address, no real process list.

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** A small seeded random generator, so every run draws the same charts. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Json = Record<string, unknown>;

const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

// ---- Roles -----------------------------------------------------------------

interface RoleDemo { state: "ready" | "loaded" | "installed" | "notInstalled"; model?: { id: string; size: number; footprint?: number }; enabled?: boolean; priority?: number; since: number }
const ROLE_DEMO: Record<string, RoleDemo> = {
  chat: { state: "ready", model: { id: "qwen3-8b-instruct-q4-k-m", size: 5_027_783_488, footprint: 6.1 * GB }, priority: 10, since: 3 * HOUR },
  judge: { state: "ready", model: { id: "qwen3-4b-q4-k-m", size: 2_497_280_256, footprint: 2.9 * GB }, priority: 20, since: 3 * HOUR },
  embed: { state: "ready", model: { id: "nomic-embed-text-v1-5-q4-k-m", size: 84 * MB, footprint: 0.4 * GB }, priority: 30, since: 3 * HOUR },
  stt: { state: "ready", model: { id: "parakeet-tdt-0.6b-v2-int8", size: 482_468_385, footprint: 0.7 * GB }, priority: 40, since: 3 * HOUR },
  tts: { state: "ready", model: { id: "pocket-tts-english", size: 219_029_196, footprint: 0.5 * GB }, priority: 50, since: 3 * HOUR },
  wakeword: { state: "installed", model: { id: "openwakeword-embedding", size: 1.3 * MB }, priority: 60, since: 2 * DAY },
  helper: { state: "installed", model: { id: "qwen3-4b-q4-k-m", size: 2_497_280_256 }, priority: 70, since: 5 * HOUR },
  image: { state: "installed", model: { id: "flux2-klein-4b", size: 7_751_109_744 }, priority: 80, since: 1 * DAY },
  video: { state: "notInstalled", enabled: false, priority: 90, since: 2 * DAY },
  music: { state: "notInstalled", enabled: false, priority: 100, since: 2 * DAY },
};

export function patchRoles(real: { roles: Json[] }): Json {
  return {
    roles: real.roles.map((r) => {
      const id = String(r.id);
      const d = ROLE_DEMO[id];
      if (!d) return { ...r, priority: 110, state: { state: "notInstalled", since: iso(2 * DAY) } };
      const model = d.model ? { id: d.model.id, sizeBytes: d.model.size, measuredFootprintBytes: d.model.footprint ?? null } : null;
      const note = id === "helper" ? "Wakes when you write to it and sleeps after 5 idle minutes." : id === "image" ? "Starts when a picture is asked for." : null;
      return { ...r, enabled: d.enabled ?? true, priority: d.priority, model, state: { state: d.state, since: iso(d.since) }, plain_reason: note, reason: null };
    }),
  };
}

// ---- Status, health --------------------------------------------------------

const PROBLEMS = [
  { code: "engine.update_waiting.llama-server", severity: "warning", title: "Chat has a newer engine waiting", text: "llama-server b12601 is installed. Chat is still running b12589 until the engine restarts.", cause: "An update was applied while chat was busy, so the Stack waited.", since: 40 * MIN, fix: { label: "Restart llama-server", action: "restart_engine" } },
  { code: "model.missing.flux2-klein-4b", severity: "warning", title: "The picture model is only half downloaded", text: "Pictures will start working as soon as the model finishes downloading.", cause: "The download was paused when the computer went to sleep.", since: 6 * HOUR, fix: { label: "Resume the download", action: "resume_install" } },
];

export function patchStatus(real: Json): Json {
  const memory = real.memory as { total_bytes: number; budget_bytes: number };
  const total = memory.total_bytes;
  return {
    ...real, health: "degraded", busy: { running: 1, waiting: 0 },
    memory: { total_bytes: total, free_bytes: Math.round(total * 0.74), budget_bytes: memory.budget_bytes, pressure: "normal" },
    problems: PROBLEMS.map((p) => ({ code: p.code, part_id: null, plain: p.title, fix: p.fix.label, since: iso(p.since) })),
  };
}
export const healthDemo = (): Json => ({ health: PROBLEMS.map((p) => ({ ...p, since: iso(p.since) })) });
export const healthzDemo = (real: Json): Json => ({ ...real, version: "0.1.0", uptimeSeconds: 3 * DAY / 1000 + 4 * HOUR / 1000 });

// ---- Engines, logs, updates ------------------------------------------------

const ENGINE_DEMO: Record<string, { installed: boolean; running: string | null; tag: string; newest?: string; needsRestart?: boolean }> = {
  "llama-server": { installed: true, running: "chat", tag: "b12589", newest: "b12601", needsRestart: true },
  "mlx-audio": { installed: true, running: "tts", tag: "0.5.9" },
  "pocket-tts": { installed: true, running: "tts", tag: "3.1.0" },
  uv: { installed: true, running: null, tag: "0.12.17" },
};
export function patchEngines(real: { engines: Json[] }): Json {
  return {
    engines: real.engines.map((e) => {
      const d = ENGINE_DEMO[String(e.name)];
      const mac = e.matchesThisMachine === true;
      if (!d || !mac) return { ...e, installed: false, running: null, currentTag: null, roleState: "notInstalled", update: null, needsRestart: false };
      return {
        ...e, installed: d.installed, running: d.running, currentTag: d.tag, newestTag: d.newest ?? d.tag, needsRestart: d.needsRestart ?? false,
        update: d.newest && d.newest !== d.tag ? { newest: d.newest, since: iso(40 * MIN) } : null,
        roleState: d.running ? "ready" : "installed", roleReason: null,
      };
    }),
  };
}

export function logsDemo(): Json {
  const at = (m: number) => iso(m * MIN);
  const lines = [
    { event: "warmup.done", trigger: "daemon-start", roles: ["chat", "embed", "stt", "tts"], at: at(180) },
    { event: "engine.started", engine: "llama-server", role: "chat", model: "qwen3-8b-instruct-q4-k-m", ms: 3820, at: at(179) },
    { event: "engine.started", engine: "llama-server", role: "judge", model: "qwen3-4b-q4-k-m", ms: 2410, at: at(179) },
    { event: "engine.started", engine: "mlx-audio", role: "tts", model: "pocket-tts-english", ms: 1760, at: at(178) },
    { event: "admin.login", at: at(120), remote: "127.0.0.1" },
    { event: "admin.action.role.enabled", role: "tts", value: true, source: "page", at: at(118) },
    { event: "update.check", engines: 4, available: 1, at: at(60) },
    { event: "update.applied", engine: "llama-server", from: "b12589", to: "b12601", needsRestart: true, at: at(40) },
    { event: "model.install.progress", model: "flux2-klein-4b", percent: 62, at: at(31) },
    { event: "model.install.paused", model: "flux2-klein-4b", reason: "computer went to sleep", at: at(30) },
    { event: "governor.admit", role: "chat", queued: 0, waitedMs: 0, at: at(12) },
    { event: "governor.admit", role: "stt", queued: 0, waitedMs: 0, at: at(9) },
    { event: "helper.chat", tools: ["get_health", "get_roles"], wakeMs: 3900, at: at(4) },
  ];
  return { lines: lines.map((l) => JSON.stringify(l)) };
}

export const updatesDemo = (): Json => ({
  checksEnabled: true,
  engines: [
    { name: "llama-server", installed: "b12589", available: "b12601", availableKnown: true, lastChecked: iso(55 * MIN), notes: "Fixes a stall with very long prompts." },
    { name: "mlx-audio", installed: "0.5.9", available: "0.5.9", availableKnown: true, lastChecked: iso(55 * MIN) },
    { name: "pocket-tts", installed: "3.1.0", available: "3.1.0", availableKnown: true, lastChecked: iso(55 * MIN) },
    { name: "uv", installed: "0.12.17", available: "0.12.17", availableKnown: true, lastChecked: iso(55 * MIN) },
  ],
  models: { lastChecked: iso(55 * MIN), entries: [{ id: "qwen3-8b-instruct-q4-k-m", installed: "7c41481", available: "7c41481" }, { id: "parakeet-tdt-0.6b-v2-int8", installed: "a1f0c3e", available: "a1f0c3e" }] },
  recommendations: [],
});

const INSTALLED: { id: string; roles: string[]; size: number }[] = [
  { id: "qwen3-8b-instruct-q4-k-m", roles: ["chat"], size: 5_027_783_488 },
  { id: "qwen3-4b-q4-k-m", roles: ["judge", "helper"], size: 2_497_280_256 },
  { id: "nomic-embed-text-v1-5-q4-k-m", roles: ["embed"], size: 84 * MB },
  { id: "parakeet-tdt-0.6b-v2-int8", roles: ["stt"], size: 482_468_385 },
  { id: "pocket-tts-english", roles: ["tts"], size: 219_029_196 },
];
export const modelsDemo = (): Json => ({
  models: INSTALLED.map((m) => ({ id: m.id, roles: m.roles, state: "installed", runtimeState: "ready", pinned: true, sizeBytes: m.size })),
});

export const readinessDemo = (): Json => ({
  latest: {
    at: iso(22 * MIN), ok: true,
    results: [{ role: "chat", ok: true, ms: 412 }, { role: "embed", ok: true, ms: 38 }, { role: "stt", ok: true, ms: 640 }, { role: "tts", ok: true, ms: 520 }],
    fitTogether: { ok: true },
  },
  running: null,
});

// ---- The Helper ------------------------------------------------------------

export function patchHelperStatus(real: Json): Json { return { ...real, installed: true, state: "ready", reason: null }; }
export const helperHistoryDemo = (): Json => ({
  messages: [
    { role: "user", content: "Is everything healthy?", at: iso(6 * MIN) },
    { role: "assistant", content: "Almost. Two things need a look. Chat has a newer llama-server waiting for a restart, and the picture model stopped at 62 percent when the computer slept. Chat, voice in, voice out and embeddings are all ready.", at: iso(5 * MIN), tools: ["get_health", "get_roles"] },
    { role: "user", content: "Restart llama-server.", at: iso(4 * MIN) },
    { role: "assistant", content: "I can do that. Chat answers pause for a few seconds while it restarts. Click Approve below to go ahead.", at: iso(4 * MIN) },
  ],
  pending: [{ id: "demo-approval-1", tool: "restart_engine", args: { name: "llama-server" }, summary: "Restart llama-server (chat answers pause for a few seconds)", at: iso(4 * MIN) }],
});

// ---- Resources -------------------------------------------------------------

type RangeId = "1h" | "24h" | "7d";
const RANGE = { "1h": { span: HOUR, step: 30 }, "24h": { span: DAY, step: 300 }, "7d": { span: 7 * DAY, step: 1800 } } as const;
const PROCS = [
  { id: "llama-server", key: "series-1" }, { id: "mlx-audio", key: "series-2" }, { id: "sherpa-onnx", key: "series-3" }, { id: "maipai-stack", key: "series-4" },
];

function point(t: number, total: number, rand: () => number, burst: boolean, queue: number) {
  const llama = (burst ? 9.4 : 9.0) * GB + rand() * 0.2 * GB;
  const audio = 2.2 * GB + rand() * 0.05 * GB;
  const sherpa = 0.7 * GB + rand() * 0.02 * GB;
  const stack = 1.1 * GB + rand() * 0.05 * GB;
  const engines = llama + audio + sherpa + stack;
  const other = (21 + 4 * Math.sin(t / (3 * HOUR)) + rand()) * GB;
  const used = engines + other;
  const cpu = burst ? 38 + rand() * 30 : 6 + rand() * 9;
  return {
    t, n: 1, total, avail: total - used, wired: 9 * GB, compressed: 1.2 * GB, swap: 0.15 * GB + rand() * 0.05 * GB, pressure: 1,
    used, used_max: used + 0.4 * GB, stack: engines, stack_max: engines + 0.2 * GB, other,
    procs: { "llama-server": llama, "mlx-audio": audio, "sherpa-onnx": sherpa, "maipai-stack": stack },
    cpu, cpu_max: Math.min(100, cpu + 8), stack_cpu: burst ? 22 + rand() * 8 : 1 + rand(), stack_cpu_max: burst ? 34 : 3,
    gpu: null, disk: 44 * GB, tps: burst ? { chat: 31 + rand() * 12, helper: 0 } : null, queue,
  };
}

export function historyDemo(range: RangeId, total: number): Json {
  const { span, step } = RANGE[range];
  const rand = rng(range === "1h" ? 11 : range === "24h" ? 23 : 37);
  const now = Date.now();
  const points = [];
  for (let t = now - span; t <= now; t += step * 1000) {
    const phase = (t / (range === "7d" ? 5 * HOUR : range === "24h" ? 50 * MIN : 7 * MIN)) % 1;
    const burst = phase < 0.22;
    points.push(point(t, total, rand, burst, burst && rand() > 0.85 ? 1 : 0));
  }
  return { range, step_seconds: step, points, roles: PROCS.map((p) => ({ id: p.id, color_key: p.key })) };
}

export function summaryDemo(total: number): Json {
  const rand = rng(5);
  const p = point(Date.now(), total, rand, true, 0);
  const sizes = p.procs as Record<string, number>;
  return {
    sampled_at: new Date().toISOString(), current: p,
    last_hour: { memory_used_peak_bytes: p.used_max + 1.5 * GB, memory_used_mean_bytes: p.used, cpu_peak: 71, cpu_mean: 19, queue_peak: 1, samples: 720 },
    roles: PROCS.map((r) => ({ id: r.id, color_key: r.key, current_bytes: sizes[r.id] ?? 0, peak_bytes: (sizes[r.id] ?? 0) * 1.08, mean_bytes: (sizes[r.id] ?? 0) * 0.99 })),
  };
}
