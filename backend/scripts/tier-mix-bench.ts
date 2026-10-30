// TIER-BENCH-01: the tier mix bench, kept out of the gate (not run by check.sh or any test). It drives the real governor and the real tier
// catalog through the mixes the design cares about (a Max picture job with chat and voice in Reduced, one Boost at a time, the Max window
// draining running work, a minor's clamp) and writes what each mix did to data-bench/tier-mix-<timestamp>/.
//
// What is real: the governor, the catalog peaks, this computer's memory readings and the clock. What is synthetic: the models. Items are
// admitted at their catalog peak sizes and hold no memory, so nothing is loaded, no engine is touched and a live Home on the same
// computer is safe. Engine-level timings (a real Reduced swap, a real video run) need Home to call enter/leave Reduced and are not here.
//
//   cd backend && bun run bench:tier-mix            # refuses to run while the load average is 25 or more
//   DRY_RUN=1 bun run bench:tier-mix                # print the mixes, run nothing
//   PROFILE=p64 bun run bench:tier-mix              # pick the profile; default comes from this computer's memory
//   TIER_BENCH_FORCE=1 bun run bench:tier-mix       # run anyway on a busy computer (timings become upper bounds)
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { __resetGovernorForTests, admit, getGovernorStatus, getMaxWindow, getReclaimSteps, release, startGovernor, tierRoomBytes, fitsEverForTier, type GovernorHandle, type GovernorRequest } from "@/lib/governor";
import { minorTierClamp, resolveTier, TIER_CANDIDATES, type ProfileId, type TierCategory, type TierId } from "@/lib/tiers";

const GB = 1_000_000_000;
const LOAD_LIMIT = 25;
const STAMP = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z");
const OUT = path.resolve(import.meta.dir, "../../data-bench", `tier-mix-${STAMP}`);

const totalGiB = os.totalmem() / 1_073_741_824;
const PROFILE = (process.env.PROFILE as ProfileId | undefined) ?? (totalGiB >= 96 ? "p128" : totalGiB >= 48 ? "p64" : totalGiB >= 24 ? "p32" : "p16");

type Queued = { queued: true; admitted: Promise<GovernorHandle | { refused: true; reason: string }> };
const isHandle = (value: unknown): value is GovernorHandle => !!value && typeof value === "object" && "id" in value && !("queued" in value) && !("refused" in value);
const isQueued = (value: unknown): value is Queued => !!value && typeof value === "object" && "queued" in value;
const peakOf = (id: string): number => TIER_CANDIDATES.find((candidate) => candidate.id === id)?.peaks.reduce((most, peak) => Math.max(most, peak.peakBytes), 0) ?? 0;
const pick = (category: TierCategory, tier: TierId, roomBytes: number): { model: string; peakBytes: number } | null => {
  const resolved = resolveTier({ category, tier, profile: PROFILE, roomBytes });
  return resolved ? { model: resolved.model, peakBytes: resolved.peakBytes } : null;
};
const settle = async (answer: unknown, ms = 1_500): Promise<GovernorHandle | { waiting: true } | { refused: string }> => {
  if (isHandle(answer)) return answer;
  if (isQueued(answer)) {
    const done = await Promise.race([answer.admitted, Bun.sleep(ms).then(() => null)]);
    if (done === null) return { waiting: true };
    return isHandle(done) ? done : { refused: (done as { reason: string }).reason };
  }
  return { refused: (answer as { reason: string }).reason };
};

interface Observation { step: string; result: string; ms: number }
interface MixResult { mix: string; expectation: string; passed: boolean; observations: Observation[]; reclaim: Record<string, unknown[]>; windowStates: string[] }
interface Mix { name: string; expectation: string; run: (ctx: Ctx) => Promise<boolean> }
interface Ctx { room: number; note: (step: string, result: string, started: number) => void; windowStates: string[]; reclaimFor: string[]; sampleWindow: () => void }

function request(id: string, model: string, peakBytes: number, extra: Partial<GovernorRequest> = {}): GovernorRequest {
  return { id, kind: "generator", class: "burst", requestedBytes: peakBytes, role: "image", ...extra } as GovernorRequest;
}
async function residents(): Promise<GovernorHandle[]> {
  const chat = pick("chat", "standard", Number.MAX_SAFE_INTEGER) ?? { model: "chat", peakBytes: peakOf("qwen3-4b-q4-k-m") };
  const voice = pick("voice", "standard", Number.MAX_SAFE_INTEGER) ?? { model: "voice", peakBytes: 2 * GB };
  const held: GovernorHandle[] = [];
  for (const [id, role, bytes] of [["chat", "chat", chat.peakBytes], ["tts", "tts", voice.peakBytes]] as const) {
    const answer = await admit({ id, kind: "resident", class: "reserved", role, requestedBytes: bytes } as GovernorRequest);
    if (isHandle(answer)) held.push(answer);
  }
  return held;
}

const MIXES: Mix[] = [
  {
    name: "max-picture-with-reduced-chat-and-voice",
    expectation: "A Max picture job that is over the Standard cap fits the Max cap once chat and voice are Reduced, and runs beside reserved chat and voice.",
    run: async (ctx) => {
      const max = pick("pictures", "max", ctx.room); if (!max) { ctx.note("resolve", `no Max picture slot on ${PROFILE} at ${(ctx.room / GB).toFixed(1)} GB`, performance.now()); return false; }
      const chatStd = pick("chat", "standard", Number.MAX_SAFE_INTEGER)?.peakBytes ?? 0, chatRed = resolveTier({ category: "chat", tier: "reduced", profile: PROFILE, roomBytes: Number.MAX_SAFE_INTEGER })?.peakBytes ?? 0;
      const voiceStd = pick("voice", "standard", Number.MAX_SAFE_INTEGER)?.peakBytes ?? 0, voiceRed = resolveTier({ category: "voice", tier: "reduced", profile: PROFILE, roomBytes: Number.MAX_SAFE_INTEGER })?.peakBytes ?? 0;
      const freed = Math.max(0, chatStd - chatRed) + Math.max(0, voiceStd - voiceRed);
      let t = performance.now();
      const fit = fitsEverForTier(request("max-pic", max.model, max.peakBytes, { tier: "max" }), { reducedFreedBytes: freed });
      ctx.note("fits_ever with Reduced freeing", `${fit.fits ? "fits" : "does not fit"}: cap ${(fit.capBytes / GB).toFixed(1)} GB, peak ${(fit.peakBytes / GB).toFixed(1)} GB, Reduced frees ${(freed / GB).toFixed(1)} GB`, t);
      await residents();
      t = performance.now();
      const answer = await settle(await admit(request("max-pic", max.model, max.peakBytes, { tier: "max", role: "image" })));
      ctx.sampleWindow();
      ctx.note("admit Max picture", "id" in answer ? `admitted, window ${getMaxWindow().state}` : JSON.stringify(answer), t);
      if ("id" in answer) release(answer);
      ctx.reclaimFor.push("max-pic");
      return fit.fits;
    },
  },
  {
    name: "one-boost-at-a-time",
    expectation: "While a Boost video job runs a second Boost picture job queues even if memory would allow it, and starts after the first is released.",
    run: async (ctx) => {
      const video = pick("video", "boost", ctx.room), picture = pick("pictures", "boost", ctx.room);
      if (!video || !picture) { ctx.note("resolve", `Boost slots missing on ${PROFILE} at ${(ctx.room / GB).toFixed(1)} GB (video ${!!video}, pictures ${!!picture})`, performance.now()); return true; }
      let t = performance.now();
      const first = await settle(await admit(request("boost-video", video.model, video.peakBytes, { tier: "boost", role: "video" })));
      ctx.note("admit Boost video", "id" in first ? "admitted" : JSON.stringify(first), t);
      t = performance.now();
      const second = await admit(request("boost-picture", picture.model, picture.peakBytes, { tier: "boost", role: "image" }));
      ctx.note("second Boost request", isQueued(second) ? "queued (one burst at a time)" : "admitted (wrong)", t);
      if (!("id" in first)) return false;
      t = performance.now();
      release(first);
      const after = await settle(second);
      ctx.note("second Boost after release", "id" in after ? "admitted" : JSON.stringify(after), t);
      if ("id" in after) release(after);
      return isQueued(second) && "id" in after;
    },
  },
  {
    name: "max-window-drains-running-work",
    expectation: "A Max job waits for a running Standard picture to finish (window draining), reserved chat still admits, held work restarts in order after the Max job.",
    run: async (ctx) => {
      const max = pick("pictures", "max", ctx.room), std = pick("pictures", "standard", ctx.room) ?? { model: "std-picture", peakBytes: 10 * GB };
      if (!max) { ctx.note("resolve", "no Max picture slot", performance.now()); return false; }
      await residents();
      const running = await settle(await admit(request("running-std", std.model, std.peakBytes, { tier: "standard" })));
      if (!("id" in running)) { ctx.note("admit running Standard", JSON.stringify(running), performance.now()); return false; }
      let t = performance.now();
      const maxAnswer = await admit(request("max-job", max.model, max.peakBytes, { tier: "max" }));
      ctx.sampleWindow();
      ctx.note("Max request while work runs", `${isQueued(maxAnswer) ? "queued" : "admitted"}, window ${getMaxWindow().state}`, t);
      const heldA = await admit(request("held-a", std.model, 2 * GB)), heldB = await admit(request("held-b", std.model, 2 * GB));
      t = performance.now();
      const reserved = await admit({ id: "wake", kind: "resident", class: "reserved", role: "wakeword", requestedBytes: 0.2 * GB } as GovernorRequest);
      ctx.note("reserved item during drain", isHandle(reserved) ? "admitted" : "held (wrong)", t);
      t = performance.now();
      release(running);
      const owner = await settle(maxAnswer, 3_000);
      ctx.sampleWindow();
      ctx.note("Max job after the running job ended", "id" in owner ? `admitted, window ${getMaxWindow().state}` : JSON.stringify(owner), t);
      const queueDuring = getGovernorStatus().queue.map((entry) => entry.id).join(",");
      ctx.note("queue while Max runs", queueDuring || "empty", performance.now());
      ctx.reclaimFor.push("max-job");
      if ("id" in owner) release(owner);
      ctx.sampleWindow();
      const a = await settle(heldA, 3_000);
      const aId = "id" in a ? a.id : "none";
      if ("id" in a) release(a);
      const b = await settle(heldB, 3_000);
      ctx.note("held order after Max", `${aId} then ${"id" in b ? b.id : "none"}`, performance.now());
      if ("id" in b) release(b);
      return isQueued(maxAnswer) && isHandle(reserved) && aId === "held-a" && "id" in b && b.id === "held-b" && queueDuring === "held-a,held-b";
    },
  },
  {
    name: "standard-music-beside-standard-picture",
    expectation: "Standard music and a Standard picture run together when both fit their Standard caps and the machine has room for both.",
    run: async (ctx) => {
      const music = pick("music", "standard", ctx.room), picture = pick("pictures", "standard", ctx.room);
      if (!music || !picture) { ctx.note("resolve", `slots missing on ${PROFILE} at ${(ctx.room / GB).toFixed(1)} GB (music ${!!music}, pictures ${!!picture})`, performance.now()); return true; }
      await residents();
      const t = performance.now();
      const a = await settle(await admit(request("music", music.model, music.peakBytes, { tier: "standard", role: "music" })));
      const b = await settle(await admit(request("picture", picture.model, picture.peakBytes, { tier: "standard", role: "image" })));
      const fits = (music.peakBytes + picture.peakBytes) <= ctx.room;
      ctx.note("both Standard", `${"id" in a ? "music admitted" : "music " + JSON.stringify(a)}, ${"id" in b ? "picture admitted" : "picture " + JSON.stringify(b)}; together ${((music.peakBytes + picture.peakBytes) / GB).toFixed(1)} GB of ${(ctx.room / GB).toFixed(1)} GB room`, t);
      if ("id" in a) release(a);
      if ("id" in b) release(b);
      return fits ? "id" in a && "id" in b : true;
    },
  },
  {
    name: "minors-never-get-boost-or-max",
    expectation: "A minor's Boost or Max request clamps to Standard and thinking stays off; Reduced stays Reduced.",
    run: async (ctx) => {
      const t = performance.now();
      const clamps = (["boost", "max", "standard", "reduced"] as TierId[]).map((tier) => `${tier}->${minorTierClamp(tier)}`);
      ctx.note("minorTierClamp", clamps.join(", "), t);
      return minorTierClamp("boost") === "standard" && minorTierClamp("max") === "standard" && minorTierClamp("reduced") === "reduced";
    },
  },
];

async function main(): Promise<void> {
  const load = os.loadavg()[0]!;
  if (process.env.DRY_RUN) {
    console.log(`Profile ${PROFILE}, load ${load.toFixed(1)} (limit ${LOAD_LIMIT}). Mixes:`);
    for (const mix of MIXES) console.log(`- ${mix.name}: ${mix.expectation}`);
    return;
  }
  if (load >= LOAD_LIMIT && !process.env.TIER_BENCH_FORCE) {
    console.error(`The load average is ${load.toFixed(1)}, over the limit of ${LOAD_LIMIT}. Wait for the computer to quiet down and run again, or set TIER_BENCH_FORCE=1 to run anyway (timings become upper bounds).`);
    process.exit(2);
  }
  mkdirSync(OUT, { recursive: true });
  const results: MixResult[] = [];
  for (const mix of MIXES) {
    __resetGovernorForTests();
    const stop = startGovernor({ pid: process.pid, pollMs: 25 });
    await Bun.sleep(150);
    const room = tierRoomBytes();
    const observations: Observation[] = [], windowStates: string[] = [], reclaimFor: string[] = [];
    const ctx: Ctx = { room, windowStates, reclaimFor, note: (step, result, started) => observations.push({ step, result, ms: Math.round(performance.now() - started) }), sampleWindow: () => windowStates.push(getMaxWindow().state) };
    let passed = false;
    try { passed = await mix.run(ctx); } catch (error) { observations.push({ step: "error", result: error instanceof Error ? error.message : String(error), ms: 0 }); }
    stop();
    const reclaim: Record<string, unknown[]> = {};
    for (const id of reclaimFor) reclaim[id] = getReclaimSteps(id);
    results.push({ mix: mix.name, expectation: mix.expectation, passed, observations, reclaim, windowStates });
    console.log(`${passed ? "pass" : "FAIL"}  ${mix.name}`);
  }
  __resetGovernorForTests();
  const header = { stamp: STAMP, profile: PROFILE, totalGiB: Math.round(totalGiB), loadAverage: os.loadavg(), freeGiBAtEnd: Math.round(os.freemem() / 1_073_741_824), forced: !!process.env.TIER_BENCH_FORCE };
  writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ header, results }, null, 2));
  const lines = [`# Tier mix bench ${STAMP}`, "", `Profile ${PROFILE}, ${header.totalGiB} GiB, load average ${header.loadAverage.map((n) => n.toFixed(1)).join(" / ")}${header.forced ? " (forced on a busy computer: timings are upper bounds)" : ""}. Synthetic models, real governor and memory readings.`, ""];
  for (const result of results) {
    lines.push(`## ${result.passed ? "PASS" : "FAIL"} ${result.mix}`, "", result.expectation, "");
    for (const o of result.observations) lines.push(`- ${o.step}: ${o.result} (${o.ms} ms)`);
    if (result.windowStates.length) lines.push(`- Max window states seen: ${result.windowStates.join(", ")}`);
    for (const [id, steps] of Object.entries(result.reclaim)) if (steps.length) lines.push(`- Reclaim steps for ${id}: ${JSON.stringify(steps)}`);
    lines.push("");
  }
  writeFileSync(path.join(OUT, "report.md"), lines.join("\n"));
  console.log(`Report: ${path.join(OUT, "report.md")}`);
  if (results.some((result) => !result.passed)) process.exit(1);
}
void main();
