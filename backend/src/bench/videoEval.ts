import { readFileSync } from "node:fs";
import { StackMakeRequest, StackMakeResult } from "@maipai/spec/stack/ts/stack-make.js";
import { StackVideoReceipt, type StackVideoReceipt as Receipt } from "@maipai/spec/stack/ts/stack-video-receipt.js";

export type EvalRow = {
  id: string; arm: string; private_testing: boolean; request: unknown;
};
export type Suite = { rows: EvalRow[] };
export type EvalResult = {
  id: string; arm: string; level: string; route: string | null; seed: number | null; steps: Receipt["steps"] | null; schedule: string | null; adapter_id: string | null;
  wall_ms: number | null; peak_memory_bytes: number | null; requested: Receipt["requested"] | null; native: Receipt["native"] | null; delivered: Receipt["delivered"] | null;
  finish: Receipt["finish"] | []; checker: { verdict: "pass" | "fail" | "not_run"; reason?: string } | null; refusal: { code: string; line: string } | null;
  receipt: Receipt | null; job_state?: string; job_id?: string; scores?: Record<string, unknown> | null;
};
export function validateSuite(file: string): Suite {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Suite;
  if (!parsed || !Array.isArray(parsed.rows) || parsed.rows.length === 0) throw new Error("Suite must contain a non-empty rows array.");
  const ids = new Set<string>();
  for (const row of parsed.rows) {
    if (!row.id || ids.has(row.id)) throw new Error(`Missing or duplicate row id: ${row.id}`);
    ids.add(row.id);
    if (typeof row.arm !== "string" || typeof row.private_testing !== "boolean") throw new Error(`${row.id}: arm and private_testing are required.`);
    const request = StackMakeRequest.parse(row.request);
    if (request.job !== "clip" || request.seconds > 5 || request.start_picture || request.end_picture || request.inputs?.length) throw new Error(`${row.id}: expected a words-only clip of at most five seconds.`);
    if (/\bH3\b/i.test(row.arm) && row.private_testing !== true) throw new Error(`${row.id}: H3 rows must be private_testing.`);
  }
  return parsed;
}
export function buildRows(receiptInput: unknown, resultInput: unknown): Omit<EvalResult, "id" | "arm" | "level" | "checker" | "refusal"> {
  const receipt = StackVideoReceipt.parse(receiptInput);
  const result = StackMakeResult.parse(resultInput);
  const reqSize = receipt.requested;
  return { route: receipt.route?.name ?? result.made_with?.route ?? null, seed: receipt.seed,
    steps: receipt.steps, schedule: receipt.steps.schedule, adapter_id: receipt.adapter?.id ?? null,
    wall_ms: receipt.phases.reduce((sum, phase) => sum + phase.ms, 0), peak_memory_bytes: receipt.peak_memory_bytes,
    requested: reqSize, native: receipt.native, delivered: receipt.delivered, finish: receipt.finish,
    receipt, job_state: result.state, job_id: result.id };
}
export function aggregate(rows: Array<Pick<EvalResult, "wall_ms" | "checker">>): { minutes_per_accepted_take: number | null; first_take_pass_rate: number | null; pass_rows: number; rows_run: number } {
  const passed = rows.filter((row) => row.checker?.verdict === "pass");
  return { minutes_per_accepted_take: passed.length ? passed.reduce((sum, row) => sum + (row.wall_ms ?? 0), 0) / passed.length / 60_000 : null,
    first_take_pass_rate: rows.length ? passed.length / rows.length : null, pass_rows: passed.length, rows_run: rows.length };
}
export function joinScores<T extends { id: string }>(rows: T[], scores: Record<string, Record<string, unknown>>): Array<T & { scores: Record<string, unknown> | null }> {
  return rows.map((row) => ({ ...row, scores: scores[row.id] ?? null }));
}
function pct(a: number | null, b: number | null): string { return a == null || b == null ? "n/a" : b === 0 ? (a === 0 ? "0%" : "new") : `${(((a - b) / b) * 100).toFixed(1)}%`; }
export function renderDelta(current: EvalResult[], previous: EvalResult[]): string {
  const prior = new Map(previous.map((row) => [row.id, row]));
  const lines = ["# Video evaluation delta", "", "| Row | Wall change | Peak change | Verdict |", "|---|---:|---:|---|"];
  for (const row of current) { const old = prior.get(row.id); if (!old) { lines.push(`| ${row.id} | new | new | new row |`); continue; }
    const a = row.checker?.verdict ?? "not_run", b = old.checker?.verdict ?? "not_run";
    lines.push(`| ${row.id} | ${pct(row.wall_ms, old.wall_ms)} | ${pct(row.peak_memory_bytes, old.peak_memory_bytes)} | ${a === b ? a : `${b} → ${a}`} |`);
  }
  return `${lines.join("\n")}\n`;
}
const cell = (value: unknown): string => value == null ? "" : String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
export function renderTable(rows: EvalResult[]): string {
  const lines = ["| Row | Arm | Level | Route | Seed | Steps / schedule | Adapter | Wall ms | Peak bytes | Requested | Native | Delivered | Finish | Checker | Refusal | Identity | Skin | Movement | Composition | Speech | Notes |", "|---|---|---|---|---:|---|---|---:|---:|---|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const row of rows) { const score = row.scores ?? {}; const resolution = (size: Receipt["requested"] | Receipt["native"] | Receipt["delivered"] | null): string => size ? `${size.width}x${size.height}` : "";
    lines.push(`| ${cell(row.id)} | ${cell(row.arm)} | ${cell(row.level)} | ${cell(row.route)} | ${cell(row.seed)} | ${cell(row.steps?.count)} / ${cell(row.schedule)} | ${cell(row.adapter_id)} | ${cell(row.wall_ms)} | ${cell(row.peak_memory_bytes)} | ${resolution(row.requested)} | ${resolution(row.native)} | ${resolution(row.delivered)} | ${cell(row.finish.map((op) => `${op.operation}:${op.ok}`).join(", "))} | ${cell(row.checker?.verdict)} | ${cell(row.refusal ? `${row.refusal.code}: ${row.refusal.line}` : "")} | ${cell(score.identity)} | ${cell(score.skin)} | ${cell(score.movement)} | ${cell(score.composition)} | ${cell(score.speech)} | ${cell(score.notes)} |`);
  }
  const totals = aggregate(rows);
  lines.push("", `Minutes per accepted take: ${totals.minutes_per_accepted_take == null ? "null" : totals.minutes_per_accepted_take.toFixed(3)}`, `First-take pass rate: ${totals.first_take_pass_rate == null ? "null" : `${(totals.first_take_pass_rate * 100).toFixed(1)}%`} (${totals.pass_rows}/${totals.rows_run})`);
  return `${lines.join("\n")}\n`;
}
