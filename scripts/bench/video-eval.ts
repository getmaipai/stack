#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildRows, joinScores, renderDelta, renderTable, validateSuite, type EvalResult } from "../../backend/src/bench/videoEval.js";

export { buildRows, joinScores, renderDelta, renderTable, validateSuite, aggregate } from "../../backend/src/bench/videoEval.js";
type Args = { stack: string; out: string; run: string; suite: string; previous?: string; only?: string[]; skipPrivate: boolean; lock?: string; scores?: string; tokenFile?: string };
function args(argv: string[]): Args {
  const out: Record<string, string> = {}; const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) { const key = argv[i]!; if (key.startsWith("--")) { if (["--skip-private"].includes(key)) flags.add(key); else { const value = argv[++i]; if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`); out[key] = value; } } else throw new Error(`Unexpected argument: ${key}`); }
  for (const key of ["--stack", "--out", "--run"]) if (!out[key]) throw new Error(`Required: ${key}`);
  const here = resolve(new URL(".", import.meta.url).pathname);
  return { stack: out["--stack"]!, out: resolve(out["--out"]!), run: out["--run"]!, suite: resolve(out["--suite"] ?? join(here, "video-eval.suite.json")), previous: out["--previous"] ? resolve(out["--previous"]!) : undefined, only: out["--only"]?.split(",").filter(Boolean), skipPrivate: flags.has("--skip-private"), lock: out["--lock"] ? resolve(out["--lock"]!) : undefined, scores: out["--scores"] ? resolve(out["--scores"]!) : undefined, ...(out["--token-file"] ? { tokenFile: resolve(out["--token-file"]!) } : {}) };
}
/** The owner's headers: the Home token (from a file the caller names, never printed) and the full view so adult clips are visible. */
let authHeaders: Record<string, string> = {};
const http = (url: string, init: RequestInit = {}) => fetch(url, { ...init, headers: { ...authHeaders, ...(init.headers as Record<string, string> | undefined) } });
const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
async function main(config: Args): Promise<void> {
  if (config.tokenFile) authHeaders = { "x-maipai-home-token": readFileSync(config.tokenFile, "utf8").trim(), "x-maipai-view": "full" };
  let rows = validateSuite(config.suite).rows;
  if (config.only) { const wanted = new Set(config.only); rows = rows.filter((row) => wanted.has(row.id)); const missing = [...wanted].filter((id) => !rows.some((row) => row.id === id)); if (missing.length) throw new Error(`Unknown row id(s): ${missing.join(", ")}`); }
  if (config.skipPrivate) rows = rows.filter((row) => !row.private_testing);
  let ownsLock = false;
  if (config.lock) {
    if (existsSync(config.lock)) { let owner = ""; try { owner = readFileSync(join(config.lock, "owner"), "utf8").trim(); } catch { /* no owner */ } if (owner !== config.run) throw new Error(`Lock exists and is owned by ${owner || "unknown"}: ${config.lock}`); }
    else { mkdirSync(config.lock, { recursive: true }); writeFileSync(join(config.lock, "owner"), `${config.run}\n`, { flag: "wx" }); ownsLock = true; }
  }
  let interrupted = false; const onInterrupt = () => { interrupted = true; }; process.on("SIGINT", onInterrupt);
  const results: EvalResult[] = [];
  try {
    for (const row of rows) {
      if (interrupted) break;
      const request = row.request as { level: string; seed?: number };
      const base: EvalResult = { id: row.id, arm: row.arm, level: request.level, route: null, seed: request.seed ?? null, steps: null, schedule: null, adapter_id: null, wall_ms: null, peak_memory_bytes: null, requested: null, native: null, delivered: null, finish: [], checker: { verdict: "not_run", reason: "No Stack route starts media.check or media.verify against the delivered clip file." }, refusal: null, receipt: null };
      try {
        const response = await http(`${config.stack.replace(/\/$/, "")}/stack/v1/jobs/make`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(row.request) });
        const body = await response.json() as Record<string, any>;
        if (response.status === 409) { base.refusal = { code: String(body.code ?? "refused"), line: String(body.line ?? "The request was refused.") }; results.push(base); continue; }
        if (!response.ok) { base.refusal = { code: String(body.code ?? `http_${response.status}`), line: String(body.line ?? body.error ?? `HTTP ${response.status}`) }; results.push(base); continue; }
        const jobId = String(body.id ?? ""); if (!jobId) { base.refusal = { code: "missing_job_id", line: "The generic make result did not contain an id." }; results.push(base); continue; }
        let result = body;
        while (["queued", "running", "paused", "stalled", "waiting_for_you"].includes(result.state)) { await sleep(1000); const poll = await http(`${config.stack.replace(/\/$/, "")}/stack/v1/jobs/${encodeURIComponent(jobId)}`); const status = await poll.json() as Record<string, any>; result = status.job?.result ?? status.job ?? status; }
        if (result.state !== "done") { base.job_state = String(result.state ?? "unknown"); const failure = result.failure ?? result.result ?? {}; base.refusal = { code: String(failure.code ?? result.code ?? base.job_state), line: String(failure.line ?? failure.message ?? result.reason ?? result.status ?? "Job did not complete.") }; results.push(base); continue; }
        const built = buildRows(result.made_with?.receipt ? await (await http(`${config.stack.replace(/\/$/, "")}/v1/videos/generations/${encodeURIComponent(result.made_with.receipt)}/receipt.json`)).json() : {}, result);
        Object.assign(base, built);
      } catch (error) { base.refusal = { code: "request_error", line: error instanceof Error ? error.message : String(error) }; }
      results.push(base);
    }
    if (config.scores) { const scores = JSON.parse(readFileSync(config.scores, "utf8")) as Record<string, Record<string, unknown>>; results.splice(0, results.length, ...joinScores(results, scores) as EvalResult[]); }
    mkdirSync(config.out, { recursive: true });
    writeFileSync(join(config.out, "run.json"), `${JSON.stringify(results, null, 2)}\n`);
    writeFileSync(join(config.out, "run.md"), `# Video evaluation ${config.run}\n\n${renderTable(results)}`);
    if (config.previous) { const previous = JSON.parse(readFileSync(config.previous, "utf8")) as EvalResult[]; writeFileSync(join(config.out, "delta.md"), renderDelta(results, previous)); }
  } finally { process.off("SIGINT", onInterrupt); if (ownsLock) rmSync(config.lock!, { recursive: true, force: true }); }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(args(process.argv.slice(2))).catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
