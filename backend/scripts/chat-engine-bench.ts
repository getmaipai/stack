// TIER-CHAT-BENCH-01: the same chat prompts against two OpenAI-compatible engines (llama-server and Splash), idle, beside a second request,
// and with a memory ballast standing in for a held Max lease. Outside the gate: it needs engines you started yourself on their own ports
// (scripts/bench/chat-engine-bench.sh starts them), never the live hub's. Refuses to run at load 25 or more unless TIER_BENCH_FORCE=1.
//
//   TARGETS='llama=http://127.0.0.1:8791|model-name|PID,splash=http://127.0.0.1:8792|model-name|PID' bun run bench:chat-engines
//   DRY_RUN=1 prints the plan. REPEATS (default 5), LONG_WORDS (default 2500), BALLAST_GB (default 0 = skip the lease rows), TOKENS (default 128).
import { loadavg, freemem, totalmem } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

type Target = { name: string; base: string; model: string; pid: number | null };
type Sample = { ok: boolean; ttftMs: number | null; tokens: number; tokPerSec: number | null; totalMs: number };
type Row = { target: string; scenario: string; prompt: string; n: number; ok: number; ttftMedianMs: number | null; ttftP90Ms: number | null; tokPerSecMedian: number | null; rssGb: number | null; minFreeGb: number };

const LOAD_LIMIT = 25;
const REPEATS = Number(process.env.REPEATS ?? 5);
const TOKENS = Number(process.env.TOKENS ?? 128);
const LONG_WORDS = Number(process.env.LONG_WORDS ?? 2500);
const BALLAST_GB = Number(process.env.BALLAST_GB ?? 0);
const GB = 1024 ** 3;

export function parseTargets(spec: string): Target[] {
  return spec.split(",").map(s => s.trim()).filter(Boolean).map(item => {
    const [name, rest] = item.split("=");
    const [base, model, pid] = (rest ?? "").split("|");
    if (!name || !base || !model) throw new Error(`TARGETS entry "${item}" must look like name=http://127.0.0.1:PORT|model|PID`);
    return { name, base: base.replace(/\/$/, ""), model, pid: pid ? Number(pid) : null };
  });
}

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]! : null);
const p90 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.9) - 1)]! : null);
const SHORT = "In two short paragraphs, tell a parent why a family might keep its own AI at home, and name three everyday things it could help with.";
const longPrompt = () => `Read this text, then answer in two sentences what it is mostly about.\n\n${"The household keeps its calendar, its recipes and its photos on one computer in the hall closet. ".repeat(Math.ceil(LONG_WORDS / 16))}`;

function rssGb(pid: number | null): number | null {
  if (!pid) return null;
  const out = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return out ? Math.round((Number(out) / 1024 / 1024) * 10) / 10 : null;
}

async function ask(t: Target, prompt: string, signal?: AbortSignal): Promise<Sample> {
  const started = performance.now();
  let first: number | null = null; let tokens = 0; let last = started;
  try {
    const res = await fetch(`${t.base}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" }, signal,
      body: JSON.stringify({ model: t.model, stream: true, max_tokens: TOKENS, temperature: 0, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok || !res.body) return { ok: false, ttftMs: null, tokens: 0, tokPerSec: null, totalMs: Math.round(performance.now() - started) };
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
        try {
          const delta = JSON.parse(line.slice(5)).choices?.[0]?.delta ?? {};
          if (delta.content || delta.reasoning_content || delta.reasoning) { const now = performance.now(); if (first === null) first = now; tokens += 1; last = now; }
        } catch { /* a keep-alive or partial line */ }
      }
    }
  } catch { return { ok: false, ttftMs: null, tokens, tokPerSec: null, totalMs: Math.round(performance.now() - started) }; }
  const decodeMs = first === null ? 0 : last - first;
  return { ok: first !== null, ttftMs: first === null ? null : Math.round(first - started), tokens, tokPerSec: decodeMs > 0 && tokens > 1 ? Math.round(((tokens - 1) / decodeMs) * 10000) / 10 : null, totalMs: Math.round(performance.now() - started) };
}

async function measure(t: Target, scenario: string, label: string, prompt: string, during?: () => Promise<() => void>): Promise<Row> {
  const stop = during ? await during() : () => {};
  let minFree = freemem() / GB; const poll = setInterval(() => { minFree = Math.min(minFree, freemem() / GB); }, 250);
  const samples: Sample[] = [];
  for (let i = 0; i < REPEATS; i++) samples.push(await ask(t, prompt));
  clearInterval(poll); stop();
  const good = samples.filter(s => s.ok);
  return { target: t.name, scenario, prompt: label, n: samples.length, ok: good.length, ttftMedianMs: median(good.map(s => s.ttftMs!)), ttftP90Ms: p90(good.map(s => s.ttftMs!)), tokPerSecMedian: median(good.filter(s => s.tokPerSec !== null).map(s => s.tokPerSec!)), rssGb: rssGb(t.pid), minFreeGb: Math.round(minFree * 10) / 10 };
}

/** A second heavy request on the same engine for the whole row. */
const secondRequest = (t: Target) => async () => {
  const ctl = new AbortController();
  const run = (async () => { while (!ctl.signal.aborted) await ask(t, longPrompt(), ctl.signal); })().catch(() => {});
  await new Promise(r => setTimeout(r, 1500));
  return () => { ctl.abort(); void run; };
};

/** Touched memory held for the row, standing in for a Max lease taking the room. */
const ballast = (gb: number) => async () => {
  const chunks: Buffer[] = [];
  for (let i = 0; i < gb; i++) chunks.push(Buffer.alloc(GB, 1));
  await new Promise(r => setTimeout(r, 1500));
  return () => { chunks.length = 0; };
};

const specText = process.env.TARGETS ?? "";
const targets = specText ? parseTargets(specText) : [];
if (process.env.DRY_RUN === "1") {
  console.log(`chat engine bench plan: targets ${targets.map(t => t.name).join(", ") || "(none; set TARGETS)"}; ${REPEATS} repeats, ${TOKENS} tokens; prompts: short and long (~${LONG_WORDS} words);`);
  console.log(`scenarios: idle, beside a second request${BALLAST_GB ? `, with ${BALLAST_GB} GB held (a Max lease)` : " (lease rows skipped, BALLAST_GB=0)"}; load now ${loadavg()[0]!.toFixed(1)}, free ${(freemem() / GB).toFixed(0)} of ${(totalmem() / GB).toFixed(0)} GB`);
  process.exit(0);
}
if (!targets.length) { console.error("Set TARGETS, for example TARGETS='llama=http://127.0.0.1:8791|model|PID,splash=http://127.0.0.1:8792|model|PID'."); process.exit(1); }
if (loadavg()[0]! >= LOAD_LIMIT && process.env.TIER_BENCH_FORCE !== "1") { console.error(`The load average is ${loadavg()[0]!.toFixed(1)}, over the limit of ${LOAD_LIMIT}. Wait for the computer to quiet down and run again, or set TIER_BENCH_FORCE=1 (timings become upper bounds).`); process.exit(1); }

const rows: Row[] = [];
for (const t of targets) {
  await ask(t, "Say OK."); // load and warm, not timed
  for (const [label, prompt] of [["short", SHORT], ["long", longPrompt()]] as const) {
    rows.push(await measure(t, "idle", label, prompt));
    rows.push(await measure(t, "beside-second-request", label, prompt, secondRequest(t)));
    if (BALLAST_GB) rows.push(await measure(t, `lease-${BALLAST_GB}gb`, label, prompt, ballast(BALLAST_GB)));
  }
}
const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
const out = path.join(import.meta.dir, "..", "..", "data-bench", `chat-engines-${stamp}`);
mkdirSync(out, { recursive: true });
const load = loadavg()[0]!.toFixed(1);
writeFileSync(path.join(out, "results.json"), JSON.stringify({ stamp, loadAtEnd: load, repeats: REPEATS, tokens: TOKENS, rows }, null, 2));
const table = ["| engine | scenario | prompt | ok/n | first token median ms | p90 ms | tok/s median | engine RSS GB | min free GB |", "|---|---|---|---|---|---|---|---|---|", ...rows.map(r => `| ${r.target} | ${r.scenario} | ${r.prompt} | ${r.ok}/${r.n} | ${r.ttftMedianMs ?? "-"} | ${r.ttftP90Ms ?? "-"} | ${r.tokPerSecMedian ?? "-"} | ${r.rssGb ?? "-"} | ${r.minFreeGb} |`)];
writeFileSync(path.join(out, "report.md"), `# Chat engine bench ${stamp}\n\nLoad average at the end: ${load}. The first token is the first content or reasoning delta; tok/s counts streamed deltas after the first.\n\n${table.join("\n")}\n`);
console.log(table.join("\n")); console.log(`report: ${out}/report.md`);
