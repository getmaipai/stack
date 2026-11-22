// The Helper (HELPER-01): the admin page's chat assistant. It runs on its own role and its own small
// model, so it still answers when `chat` is down. Read tools run at once and return plain sentences. A
// change is only ever PROPOSED: the server keeps the proposal by id and runs it when the admin confirms
// that exact card (helperActions.ts). History lives in the Stack's `meta` table (one row) with a clear button.
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { logger } from "@/lib/log";
import { HELPER_SYSTEM_PROMPT, helperTool, helperToolSpecs, type RouteCall, type ToolOutcome } from "@/lib/helperTools";
import { buildProposal, PROPOSAL_TTL_MS, runProposal, sameParams, type Proposal } from "@/lib/helperActions";
import { interpretationHint, roleLabel, topicFromCalls, type Topic } from "@/lib/helperKnowledge";
import { interpret } from "@/lib/helperInterpret";
import { explainTerm, readEngineUse, readHardware, readHealth, readLogs, readMemory, readModels, readRoles, readSettings, readUpdates } from "@/lib/helperReads";
import { STACK_HELPER_MODEL_ID } from "@/lib/modelCatalog";
import { getModel } from "@/lib/modelStore";

export type { RouteCall, ToolOutcome };
export type HelperCall = { name: string; args: Record<string, unknown> };
export type ChatMessage = { role: "user" | "assistant"; content: string; at: string; tools?: string[]; calls?: HelperCall[]; topic?: Topic };
export type Pending = Proposal;

const HISTORY_KEY = "helper.history";
const HISTORY_MAX = 40;
const MAX_ROUNDS = 4;
const MESSAGE_MAX = 2000;
export const HELPER_MESSAGE_MAX = MESSAGE_MAX;

// --- model door (a test replaces it) -----------------------------------
export type ModelCall = (body: Record<string, unknown>) => Promise<{ message: { content?: string | null; tool_calls?: Array<{ id?: string; function: { name: string; arguments: string | Record<string, unknown> } }> } }>;
const realModel: ModelCall = async (body) => {
  const { requestRole } = await import("@/lib/supervisor");
  const reply = await requestRole("helper", "/v1/chat/completions", body);
  if (reply.status !== 200) throw new Error(`The Helper's model answered ${reply.status}.`);
  const json = reply.body as { choices?: Array<{ message?: { content?: string | null; tool_calls?: never } }> };
  const message = json?.choices?.[0]?.message;
  if (!message) throw new Error("The Helper's model sent no answer.");
  return { message: message as never };
};
let model: ModelCall = realModel;
export function setHelperModelForTests(next: ModelCall | null): void { model = next ?? realModel; }
/** Whether the Helper's pinned model file is on disk (a scripted test model counts as installed). */
export function helperModelInstalled(): boolean { return model !== realModel || !!getModel(STACK_HELPER_MODEL_ID)?.modelPath; }

// --- tool door (a test replaces it) ------------------------------------
const realRoute: RouteCall = async (method, path, body) => {
  const { app } = await import("@/app");
  const response = await app.request(path, { method, headers: { "content-type": "application/json", host: "127.0.0.1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: response.status, json };
};
let route: RouteCall = realRoute;
export function setHelperRouteForTests(next: RouteCall | null): void { route = next ?? realRoute; }

/** Runs one read tool. Returns text the model reads; a failure says what could not be read, in plain words. */
export async function runRead(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  switch (name) {
    case "get_health": return readHealth(route);
    case "get_roles": return readRoles(route, args);
    case "get_models": return readModels(route, args);
    case "get_memory": return readMemory(route);
    case "get_engine_use": return readEngineUse(route, args);
    case "get_hardware": return readHardware(route);
    case "get_updates": return readUpdates(route);
    case "get_settings": return readSettings(String(args.prefix ?? "stack."));
    case "get_logs": return readLogs(route, Number(args.tail) || 50);
    case "explain": return explainTerm(String(args.term ?? ""));
    default: return { ok: false, text: `There is no tool called ${name}.` };
  }
}

// --- the reply: no tool talk, and nothing the tools did not say --------
const LEAK = /\b(get_[a-z_]+|propose_action|explain tool|function|tool call|tool result)\b|does not exist|The Stack answered \d{3}|No setting starts/i;
const BYTES = /\b\d{1,3}(,\d{3}){2,}\b|\b\d{9,}\b/;
/** Removes what must never reach the admin: tool names, a "Looked at" line the model typed, raw error text. */
export function cleanReply(raw: string, hadFailure: boolean, hadSuccess: boolean): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/\s*Looked at:[\s\S]*$/i, "").trim();
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).filter((x) => x.trim() && !LEAK.test(x) && !BYTES.test(x));
  text = sentences.join(" ").trim();
  if (!text || (hadFailure && !hadSuccess)) return "I could not read that just now. Try again, or look on the Models or Settings screen.";
  return text;
}

const numbersIn = (s: string): number[] => [...s.replace(/(\d),(?=\d{3}\b)/g, "$1").matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
const ID_LIKE = /\b[a-z][a-z0-9]*(?:[-.][a-z0-9]+){2,}\b/gi;
export interface Grounded { text: string; dropped: number }
/** Keeps only sentences whose numbers and model ids appear in what the tools returned this turn (or in the question). */
export function groundReply(reply: string, evidence: string): Grounded {
  const known = numbersIn(evidence);
  const flat = evidence.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const sentences = reply.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim());
  const kept: string[] = [];
  let dropped = 0;
  for (const s of sentences) {
    let ok = true;
    for (const id of s.match(ID_LIKE) ?? []) if (!flat.includes(id.toLowerCase().replace(/[^a-z0-9]+/g, ""))) ok = false;
    for (const n of numbersIn(s)) {
      if (n < 10 && Number.isInteger(n)) continue;
      if (!known.some((k) => Math.abs(k - n) <= Math.max(0.55, k * 0.03))) ok = false;
    }
    if (ok) kept.push(s); else dropped++;
  }
  return { text: kept.join(" ").trim(), dropped };
}

// --- state --------------------------------------------------------------
type Status = "pending" | "used" | "cancelled" | "rejected";
const proposals = new Map<string, { p: Proposal; status: Status }>();
const TOMBSTONES = 200;
function sweep(): void {
  if (proposals.size > TOMBSTONES) { for (const [id, v] of proposals) { if (v.status !== "pending") proposals.delete(id); if (proposals.size <= TOMBSTONES / 2) break; } }
}
const expired = (p: Proposal) => Date.parse(p.expires_at) <= Date.now();
export function listPending(): Pending[] { sweep(); return [...proposals.values()].filter((v) => v.status === "pending" && !expired(v.p)).map((v) => v.p); }
export function __resetHelperForTests(): void { proposals.clear(); clearHistory(); model = realModel; route = realRoute; }
/** A test moves a proposal's clock; nothing else uses it. */
export function __expireProposalForTests(id: string): void { const v = proposals.get(id); if (v) v.p = { ...v.p, expires_at: new Date(Date.now() - 1000).toISOString() }; }

export function readHistory(): ChatMessage[] {
  const row = db.select({ value: meta.value }).from(meta).where(eq(meta.key, HISTORY_KEY)).get();
  if (!row) return [];
  try { const parsed = JSON.parse(row.value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
function writeHistory(messages: ChatMessage[]): void {
  const value = JSON.stringify(messages.slice(-HISTORY_MAX));
  db.insert(meta).values({ key: HISTORY_KEY, value }).onConflictDoUpdate({ target: meta.key, set: { value } }).run();
}
export function clearHistory(): void { db.delete(meta).where(eq(meta.key, HISTORY_KEY)).run(); proposals.clear(); }

function audit(event: string, extra: Record<string, string>): void {
  // "approvedBy" appears only where an admin actually clicked Confirm.
  logger.appendLine(JSON.stringify({ event: `admin.action.helper.${event}`, at: new Date().toISOString(), source: "helper", ...(event === "approved" ? { approvedBy: "admin" } : {}), ...extra }));
}

/** The page's own notices are shown in the chat but not fed back to the model, which would copy their wording into plain answers. */
const NOTICE = /^(I can do that|Here is the change|I need your approval before|Done: |Okay, I did not do it|That did not work)/;
export function isNotice(message: ChatMessage): boolean { return message.role === "assistant" && NOTICE.test(message.content); }

export interface ChatResult { reply: string; pending: Pending[]; tools: string[]; calls: HelperCall[]; wakeMs: number; dropped: number }

function parseArgs(raw: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw !== "string") return raw;
  try { const parsed = JSON.parse(raw); return parsed && typeof parsed === "object" ? parsed : {}; } catch { return {}; }
}

const lastTopic = (history: ChatMessage[]): Topic | null => { for (let i = history.length - 1; i >= 0; i--) { const m = history[i]!; if (m.role === "assistant" && m.topic) return m.topic; } return null; };
const describeTopic = (t: Topic | null): string => (t && (t.role || t.tier || t.engine) ? `The question before was about ${[t.role ? `the ${roleLabel(t.role)} feature (${t.role})` : "", t.tier ? `the ${t.tier} tier` : "", t.engine ? `the ${t.engine} engine` : ""].filter(Boolean).join(", ")}.` : "");

/** A small model sometimes types its tool call as text (`explain {"term": "splash"}`) instead of calling it. This reads that back as a call. */
export function salvageCalls(content: string): Array<{ function: { name: string; arguments: Record<string, unknown> } }> {
  const text = content.replace(/<\/?tool_call>/g, "").trim();
  const named = /^([a-z_]+)\s*(\{[\s\S]*\})$/.exec(text);
  try {
    if (named && helperTool(named[1]!)) return [{ function: { name: named[1]!, arguments: JSON.parse(named[2]!) } }];
    const json = text.startsWith("{") ? JSON.parse(text) : null;
    if (json?.name && helperTool(String(json.name))) return [{ function: { name: String(json.name), arguments: json.arguments ?? json.parameters ?? {} } }];
  } catch { /* not a call */ }
  return [];
}

/** One admin message in, one answer out. The message is read first (helperInterpret.ts); read tools run inside; a change comes back as a proposal card. */
export async function chat(text: string): Promise<ChatResult> {
  const history = readHistory();
  const now = () => new Date().toISOString();
  const previous = lastTopic(history);
  history.push({ role: "user", content: text, at: now() });
  // STACK_HELPER_INTERPRET=off is for the eval only: it measures the model and its tools without the reading step.
  const plan = process.env.STACK_HELPER_INTERPRET === "off" ? { reads: [] } : interpret(text, previous);
  const calls: HelperCall[] = [];
  const used: string[] = [];
  const parked: Proposal[] = [];
  const evidence: string[] = [text];
  let wakeMs = 0;
  let dropped = 0;
  let reply = "";

  const park = async (action: string, params: Record<string, unknown>): Promise<string | null> => {
    const outcome = await buildProposal(route, action, params);
    if (!outcome.ok) return outcome.kind === "ambiguous" ? `${outcome.message} Which one do you mean?` : outcome.message;
    const at = new Date();
    const p: Proposal = { id: crypto.randomUUID(), ...outcome.proposal, at: at.toISOString(), expires_at: new Date(at.getTime() + PROPOSAL_TTL_MS).toISOString() };
    proposals.set(p.id, { p, status: "pending" }); parked.push(p);
    audit("proposed", { id: p.id, action: p.action, params: JSON.stringify(p.params).slice(0, 300) });
    return null;
  };
  const fixedAsk = () => `Here is the change: ${parked.map((p) => p.summary).join("; ")}. Check the card and click Confirm. Nothing has changed yet.`;

  if (plan.say) reply = plan.say;
  else if (plan.action) {
    calls.push({ name: "propose_action", args: { action: plan.action.action, ...plan.action.params } });
    const refusal = await park(plan.action.action, plan.action.params);
    reply = refusal ?? fixedAsk();
  }
  if (reply) {
    history.push({ role: "assistant", content: reply, at: now(), calls, topic: topicFromCalls(calls.map((c) => ({ name: c.name, args: c.args })), text) });
    writeHistory(history);
    return { reply, pending: parked, tools: used, calls, wakeMs, dropped };
  }

  const hint = interpretationHint(text, previous);
  const prefetched = plan.reads.length > 0;
  const system = [HELPER_SYSTEM_PROMPT, prefetched ? "The facts for this question are already in the tool results below. Answer from them in plain words and do not ask the admin to look anything up." : "", describeTopic(previous), hint].filter(Boolean).join("\n");
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: system },
    ...history.filter((m) => !isNotice(m)).slice(-8).map((m) => ({ role: m.role, content: m.content })),
  ];
  let failed = false;
  let succeeded = false;
  const leads: Array<{ lead: string; must: Array<string | RegExp> }> = [];
  if (prefetched) {
    const fetched: Array<{ id: string; name: string; args: Record<string, unknown>; text: string }> = [];
    for (const [i, r] of plan.reads.entries()) {
      calls.push({ name: r.name, args: r.args });
      const outcome = await runRead(r.name, r.args);
      if (outcome.ok) { used.push(r.name); succeeded = true; evidence.push(outcome.text); if (outcome.lead) leads.push({ lead: outcome.lead, must: outcome.must ?? [] }); fetched.push({ id: `pre_${i}`, name: r.name, args: r.args, text: outcome.text }); }
      else failed = true;
    }
    if (fetched.length > 0) {
      messages.push({ role: "assistant", content: "", tool_calls: fetched.map((f) => ({ id: f.id, type: "function", function: { name: f.name, arguments: JSON.stringify(f.args) } })) });
      for (const f of fetched) messages.push({ role: "tool", tool_call_id: f.id, content: f.text });
    }
  }
  const started = Date.now();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const answer = await model({ model: "helper", temperature: 0, max_tokens: 400, messages, tools: helperToolSpecs() });
    if (round === 0) wakeMs = Date.now() - started;
    let toolCalls = answer.message.tool_calls ?? [];
    if (toolCalls.length === 0) toolCalls = salvageCalls(answer.message.content ?? "") as never;
    if (toolCalls.length === 0) {
      const cleaned = cleanReply(answer.message.content ?? "", failed, succeeded);
      const grounded = used.length > 0 ? groundReply(cleaned, evidence.join("\n")) : { text: cleaned, dropped: 0 };
      dropped += grounded.dropped;
      reply = grounded.text || (used.length > 0 ? "I could not confirm that from the Stack just now. Ask again, or look on the Models or Resources screen." : cleaned);
      // The one fact that was asked for must be in the answer. If the small model left it out, its wording is not trusted
      // (it may contradict the fact), so the Stack's own sentence is the answer.
      const missing = leads.filter((l) => !l.must.every((m) => (typeof m === "string" ? reply.toLowerCase().includes(m.toLowerCase()) : m.test(reply))));
      if (missing.length > 0) reply = missing.map((l) => l.lead).join(" ");
      break;
    }
    messages.push({ role: "assistant", content: answer.message.content ?? "", tool_calls: toolCalls.map((c, i) => ({ id: c.id ?? `call_${round}_${i}`, type: "function", function: { name: c.function.name, arguments: typeof c.function.arguments === "string" ? c.function.arguments : JSON.stringify(c.function.arguments) } })) });
    for (const [i, call] of toolCalls.entries()) {
      const id = call.id ?? `call_${round}_${i}`;
      const tool = helperTool(call.function.name);
      const args = parseArgs(call.function.arguments);
      let result: string;
      if (!tool) { failed = true; result = `There is no tool called ${call.function.name}. Use one from the list.`; }
      else if (tool.kind === "read") {
        calls.push({ name: tool.name, args });
        const outcome = await runRead(tool.name, args);
        if (outcome.ok) { used.push(tool.name); succeeded = true; result = outcome.text; evidence.push(outcome.text); }
        else { failed = true; result = `COULD NOT READ: ${outcome.text.slice(0, 300)} Try another tool once, otherwise say plainly that you could not read it.`; }
      } else {
        const { action, ...rest } = args;
        calls.push({ name: tool.name, args });
        const refusal = await park(String(action ?? ""), rest);
        if (refusal) { result = `NOT PROPOSED: ${refusal} Tell the admin this in one plain sentence, or ask the one question it needs.`; evidence.push(refusal); succeeded = true; }
        else result = "Waiting for the administrator to click Confirm on the card. Nothing has changed yet.";
      }
      messages.push({ role: "tool", tool_call_id: id, content: result });
    }
    if (parked.length > 0) { reply = fixedAsk(); break; }
  }
  if (!reply) reply = "I could not put an answer together. Try asking a shorter question.";
  history.push({ role: "assistant", content: reply, at: now(), ...(used.length > 0 ? { tools: used } : {}), calls, topic: topicFromCalls(calls.map((c) => ({ name: c.name, args: c.args })), text) });
  writeHistory(history);
  return { reply, pending: parked, tools: used, calls, wakeMs, dropped };
}

export type Decision =
  | { ok: true; summary: string; result: string }
  | { ok: false; code: "not_found" | "expired" | "used" | "edited" | "failed"; error: string };

function note(content: string): void {
  const history = readHistory();
  history.push({ role: "assistant", content, at: new Date().toISOString() });
  writeHistory(history);
}

/** Runs one proposal, once, and only when the posted action and parameters are exactly the ones that were shown. */
export async function confirm(id: string, posted: { action?: unknown; params?: unknown }): Promise<Decision> {
  sweep();
  const entry = proposals.get(id);
  if (!entry) return { ok: false, code: "not_found", error: "The Helper never proposed that change in this chat, or the chat was cleared. Ask the Helper again." };
  if (entry.status !== "pending") return { ok: false, code: "used", error: entry.status === "used" ? "That change was already made." : "That change was cancelled. Ask the Helper again." };
  if (expired(entry.p)) { entry.status = "cancelled"; audit("expired", { id, action: entry.p.action }); return { ok: false, code: "expired", error: "That proposal ran out after 10 minutes. Ask the Helper again." }; }
  const postedParams = posted.params && typeof posted.params === "object" ? (posted.params as Record<string, unknown>) : null;
  if (posted.action !== entry.p.action || !postedParams || !sameParams(postedParams, entry.p.params)) {
    entry.status = "rejected";
    audit("rejected", { id, reason: "changed", proposed: `${entry.p.action} ${JSON.stringify(entry.p.params)}`.slice(0, 200), posted: `${String(posted.action)} ${JSON.stringify(posted.params)}`.slice(0, 200) });
    return { ok: false, code: "edited", error: "That change does not match what was proposed, so nothing was done. Ask the Helper again." };
  }
  entry.status = "used";
  const { p } = entry;
  audit("approved", { id, action: p.action, params: JSON.stringify(p.params).slice(0, 300) });
  const outcome = await runProposal(route, p);
  note(outcome.ok ? `Done: ${p.summary}.` : `That did not work (${p.summary}): ${outcome.text.slice(0, 300)}`);
  if (!outcome.ok) return { ok: false, code: "failed", error: outcome.text.slice(0, 400) };
  return { ok: true, summary: p.summary, result: outcome.text.slice(0, 600) };
}

export function cancel(id: string): boolean {
  const entry = proposals.get(id);
  if (!entry || entry.status !== "pending") return false;
  entry.status = "cancelled";
  audit("denied", { id, action: entry.p.action });
  note(`Okay, I did not do it: ${entry.p.summary}.`);
  return true;
}
