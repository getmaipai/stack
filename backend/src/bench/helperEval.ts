// Runs the Helper answer-quality eval (helperEvalSet.ts) against a running SCRATCH Stack that has the real
// Helper model, and prints the pass rate and every miss with the reply that earned it.
//
//   bun backend/src/bench/helperEval.ts --base http://127.0.0.1:PORT --cookie-file FILE [--set main|held|all] [--only id,id] [--out results.json]
//
// FILE holds the value of the scratch Stack's `stack_admin` cookie after you set up and sign in as its admin.
// Never point this at a live hub: it clears the Helper chat before every case and may park proposals (it never
// confirms one). Results are recorded in docs/helper-bench.md. Not part of the gate.
import { readFileSync, writeFileSync } from "node:fs";
import { EVAL_SET, HELD_OUT, type EvalCase, type Truth } from "@/bench/helperEvalSet";

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const base = arg("base") ?? "http://127.0.0.1:28417";
const cookie = readFileSync(arg("cookie-file")!, "utf8").trim();
const only = arg("only")?.split(",");
const headers = { cookie: `stack_admin=${cookie}`, "x-stack-admin": "1", origin: base, "content-type": "application/json" };
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
};

async function truth(): Promise<Truth> {
  const [roles, tiers, memory, hardware] = await Promise.all([call("GET", "/stack/v1/roles"), call("GET", "/stack/v1/tiers/candidates?category=pictures"), call("GET", "/stack/v1/memory"), call("GET", "/stack/v1/hardware")]);
  const splash = [...(memory.json.top_consumers ?? []), ...(memory.json.stack?.processes ?? [])].filter((p: any) => /splash/i.test(p.name)).sort((a: any, b: any) => b.bytes - a.bytes)[0];
  return { roles: roles.json.roles, tiersPictures: tiers.json, memory: memory.json, hardware: hardware.json, splashGb: splash ? splash.bytes / 1e9 : null, availableGb: memory.json.memory.available_bytes / 1e9 };
}

interface Turn { reply: string; pending: Array<Record<string, any>>; tools: string[]; calls?: Array<{ name: string; args: Record<string, any> }>; dropped?: number }
/** The new proposal card and the older parked change both read as { action, params }. */
function normalize(p: Record<string, any>): { action: string; params: Record<string, any> } {
  if (p.action) return { action: p.action, params: p.params ?? {} };
  const a = p.args ?? {};
  if (p.tool === "set_role_enabled") return { action: "set_role_enabled", params: { role: a.role, enabled: a.enabled === true || a.enabled === "true" } };
  if (p.tool === "restart_engine") return { action: "restart_engine", params: { name: a.name } };
  return { action: p.tool, params: a };
}

const DEFAULT_FORBID: RegExp[] = [/\b\d{1,3}(,\d{3}){2,}\b/, /\b\d{9,}\b/, /\bget_[a-z_]+\b/, /propose_action/, /could not read that/i];

function grade(c: EvalCase, t: Truth, turn: Turn): { pass: boolean; why: string[] } {
  const why: string[] = [];
  const reply = turn.reply.toLowerCase();
  const e = c.expect;
  for (const group of typeof e.facts === "function" ? e.facts(t) : (e.facts ?? [])) if (!group.some((w) => reply.includes(w.toLowerCase()))) why.push(`missing one of: ${group.join(" | ")}`);
  if (e.gbNear) {
    const want = e.gbNear(t);
    if (want === null) { /* nothing to compare when the thing is not running */ } else {
      const tol = e.gbTolerance ?? 0.6;
      const found = [...turn.reply.matchAll(/(\d+(?:\.\d+)?)\s*GB/gi)].map((m) => Number(m[1]));
      if (!found.some((n) => Math.abs(n - want) <= tol)) why.push(`no size near ${want.toFixed(1)} GB (found ${found.join(", ") || "none"})`);
    }
  }
  const cards = turn.pending.map(normalize);
  if (e.proposal) {
    const hit = cards.find((x) => x.action === e.proposal!.action);
    if (!hit) why.push(`no ${e.proposal.action} card (got ${cards.map((x) => x.action).join(", ") || "none"})`);
    else for (const [k, v] of Object.entries(e.proposal.params ?? {})) if (String(hit.params[k]) !== String(v)) why.push(`card ${k}=${String(hit.params[k])}, wanted ${String(v)}`);
    if (cards.length > 1) why.push(`${cards.length} cards, wanted one`);
  }
  if (e.noProposal && cards.length > 0) why.push(`unwanted card: ${cards.map((x) => x.action).join(", ")}`);
  if (e.question && !turn.reply.includes("?")) why.push("not a question");
  for (const f of [...DEFAULT_FORBID, ...(e.forbid ?? []).map((x) => (typeof x === "string" ? new RegExp(x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : x))]) if (f.test(turn.reply)) why.push(`forbidden: ${f}`);
  return { pass: why.length === 0, why };
}

async function ask(text: string): Promise<Turn> {
  const r = await call("POST", "/stack/v1/helper/chat", { message: text });
  if (r.status !== 200) return { reply: `[HTTP ${r.status}] ${r.json.error ?? ""}`, pending: [], tools: [] };
  return r.json as Turn;
}

const t = await truth();
const results: Array<Record<string, unknown>> = [];
let pass = 0;
const started = Date.now();
const cases = (arg("set") === "held" ? HELD_OUT : arg("set") === "all" ? [...EVAL_SET, ...HELD_OUT] : EVAL_SET).filter((c) => !only || only.includes(c.id));
for (const c of cases) {
  await call("DELETE", "/stack/v1/helper/history");
  for (const b of c.before ?? []) await ask(b);
  const t0 = Date.now();
  const turn = await ask(c.say);
  const ms = Date.now() - t0;
  const g = grade(c, t, turn);
  if (g.pass) pass++;
  results.push({ id: c.id, kind: c.kind, say: c.say, pass: g.pass, why: g.why, reply: turn.reply, tools: turn.tools, calls: turn.calls?.map((x) => `${x.name}(${JSON.stringify(x.args)})`), cards: turn.pending.map(normalize), dropped: turn.dropped ?? null, ms });
  console.log(`${g.pass ? "PASS" : "FAIL"} ${c.id} (${ms} ms)${g.pass ? "" : `\n   say:   ${c.say}\n   reply: ${turn.reply.replace(/\n/g, " ").slice(0, 300)}\n   why:   ${g.why.join("; ")}`}`);
}
await call("DELETE", "/stack/v1/helper/history");
const kinds = [...new Set(cases.map((c) => c.kind))].map((k) => { const r = results.filter((x) => x.kind === k); return `${k} ${r.filter((x) => x.pass).length}/${r.length}`; });
const summary = { passed: pass, of: cases.length, rate: Math.round((pass / cases.length) * 1000) / 10, byKind: kinds, seconds: Math.round((Date.now() - started) / 1000), medianMs: [...results].map((x) => x.ms as number).sort((a, b) => a - b)[Math.floor(results.length / 2)] };
console.log(JSON.stringify(summary));
const out = arg("out");
if (out) writeFileSync(out, JSON.stringify({ summary, results }, null, 1));
