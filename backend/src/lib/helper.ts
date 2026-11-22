// The Helper (HELPER-01): the admin page's chat assistant. It runs on its
// own role and its own small model, so it still answers when `chat` is down.
// Read tools run at once; every write is parked as a pending approval and
// runs only when the signed-in admin approves it in the page. Tools call the
// same /stack/v1 routes the page uses, in process. History lives in the
// Stack's `meta` table (one row) and has a clear button.
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { logger } from "@/lib/log";
import { HELPER_SYSTEM_PROMPT, helperTool, helperToolSpecs, type HelperTool } from "@/lib/helperTools";
import { STACK_HELPER_MODEL_ID } from "@/lib/modelCatalog";
import { getModel } from "@/lib/modelStore";
import { ROLE_IDS } from "@/roles";
import { SETTINGS, settingValues } from "@/settings";

export type ChatMessage = { role: "user" | "assistant"; content: string; at: string; tools?: string[] };
export interface Pending { id: string; tool: string; args: Record<string, unknown>; summary: string; at: string; }
export interface ToolOutcome { ok: boolean; text: string; }

const HISTORY_KEY = "helper.history";
const HISTORY_MAX = 40;
const PENDING_TTL_MS = 10 * 60_000;
const MAX_ROUNDS = 4;
const RESULT_CHARS = 2800;
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
export type RouteCall = (method: string, path: string, body?: unknown) => Promise<{ status: number; json: unknown }>;
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

const clip = (text: string) => (text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}\n[cut: ${text.length - RESULT_CHARS} more characters]` : text);

function slimRoles(json: unknown): unknown {
  const roles = (json as { roles?: Array<Record<string, any>> })?.roles;
  if (!Array.isArray(roles)) return json;
  return roles.map((r) => ({ id: r.id, on: r.enabled, priority: r.priority, state: r.state?.state, reason: r.reason ?? r.state?.reason ?? undefined, model: r.model?.id ?? null }));
}

const SECRET_SETTING = /token|secret|password|key$|_key|cookie/i;
function settingsText(prefix: string): string {
  const values = settingValues();
  const lines = SETTINGS.filter((s) => s.key.startsWith(prefix) && !SECRET_SETTING.test(s.key)).map((s) => `${s.key}=${String(values[s.key] ?? s.default)}`);
  if (lines.length > 0) return lines.join("\n");
  const prefixes = [...new Set(SETTINGS.filter((x) => !SECRET_SETTING.test(x.key)).map((x) => x.key.split(".").slice(0, 3).join(".")))].slice(0, 40);
  return `No setting starts with "${prefix}". Real prefixes: ${prefixes.join(", ")}.`;
}

/** The one role's model, from the roles route, never from the model's memory. */
function roleModelText(json: unknown, role: string): ToolOutcome {
  const roles = (json as { roles?: Array<Record<string, any>> })?.roles;
  const r = Array.isArray(roles) ? roles.find((x) => x.id === role) : undefined;
  if (!r) return { ok: false, text: `There is no role called "${role}". Real roles: ${ROLE_IDS.join(", ")}.` };
  const on = r.enabled ? "on" : "off";
  const state = r.state?.state ?? "unknown";
  const model = r.model?.id ? `the model is ${r.model.id}` : "no model is installed for it";
  return { ok: true, text: `Role ${role} is ${on}, state ${state}; ${model}.` };
}

const LEAK = /\b(get_[a-z_]+|set_[a-z_]+|restart_[a-z]+|function|tool)\b|does not exist|The Stack answered \d{3}|No setting starts/i;
/** Removes what must never reach the admin: a tool's raw error, tool names, a "Looked at" line the model typed itself. */
export function cleanReply(raw: string, hadFailure: boolean, hadSuccess: boolean): string {
  let text = raw.replace(/\s*Looked at:[\s\S]*$/i, "").trim();
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).filter((x) => x.trim() && !LEAK.test(x));
  text = sentences.join(" ").trim();
  if (!text || (hadFailure && !hadSuccess)) return "I could not read that just now. Try again, or look on the Models or Settings screen.";
  return text;
}

/** The plain sentence the Approve button shows. */
export function summarizeWrite(tool: string, args: Record<string, unknown>): string {
  const a = (k: string) => String(args[k] ?? "");
  switch (tool) {
    case "set_role_enabled": return `Turn ${a("role")} ${args.enabled === true || args.enabled === "true" ? "on" : "off"}`;
    case "set_setting": return `Set ${a("key")} to ${a("value")}`;
    case "restart_engine": return `Restart the ${a("name")} engine`;
    case "restart_stack": return "Restart the Stack";
    case "check_updates": return "Check the catalog for newer engine builds";
    case "apply_update": return `Install the newer ${a("name")} build`;
    case "rollback_update": return `Go back to ${a("name")} build ${a("tag")}`;
    default: return tool;
  }
}

const ENGINE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const BUILD_TAG = /^[A-Za-z0-9._-]{1,64}$/;

/** Checks a write's arguments before it is offered or run; returns the reason it is refused, or null. */
export function refuseWrite(tool: string, args: Record<string, unknown>): string | null {
  switch (tool) {
    case "set_role_enabled":
      if (!ROLE_IDS.includes(String(args.role) as never)) return `There is no role called "${String(args.role)}". Use get_roles for the names.`;
      if (typeof args.enabled !== "boolean" && args.enabled !== "true" && args.enabled !== "false") return "enabled must be true or false.";
      return null;
    case "set_setting": {
      const key = String(args.key ?? "");
      const declaration = SETTINGS.find((s) => s.key === key);
      if (!declaration) return `There is no setting called "${key}". Use get_settings for the names.`;
      if (key.startsWith("stack.admin.") || SECRET_SETTING.test(key)) return "The Helper may not change admin, sign-in or secret settings. Change it by hand on the Settings screen.";
      return null;
    }
    case "restart_engine": case "apply_update": return ENGINE_NAME.test(String(args.name ?? "")) ? null : "Give the engine name from get_roles or get_updates.";
    case "rollback_update": return ENGINE_NAME.test(String(args.name ?? "")) && BUILD_TAG.test(String(args.tag ?? "")) ? null : "Give the engine name and the build tag to return to.";
    default: return null;
  }
}

function coerceSetting(key: string, raw: unknown): unknown {
  const declaration = SETTINGS.find((s) => s.key === key);
  if (declaration?.selector === "number") return Number(raw);
  if (declaration?.selector === "boolean") return raw === true || raw === "true";
  return String(raw);
}

/** Runs one tool. Reads are always safe; a write must only be called from `approve`. */
export async function runTool(tool: HelperTool, args: Record<string, unknown>): Promise<ToolOutcome> {
  const bad = tool.kind === "write" ? refuseWrite(tool.name, args) : null;
  if (bad) return { ok: false, text: bad };
  const done = (r: { status: number; json: unknown }): ToolOutcome => {
    const text = typeof r.json === "string" ? r.json : JSON.stringify(r.json);
    return { ok: r.status < 400, text: r.status < 400 ? clip(text) : `The Stack answered ${r.status}: ${clip(text)}` };
  };
  const enc = (v: unknown) => encodeURIComponent(String(v));
  switch (tool.name) {
    case "get_health": return done(await route("GET", "/stack/v1/health"));
    case "get_roles": { const r = await route("GET", "/stack/v1/roles"); return done({ ...r, json: slimRoles(r.json) }); }
    case "get_role_model": { const r = await route("GET", "/stack/v1/roles"); return r.status >= 400 ? done(r) : roleModelText(r.json, String(args.role ?? "")); }
    case "get_memory": return done(await route("GET", "/stack/v1/memory"));
    case "get_hardware": return done(await route("GET", "/stack/v1/hardware"));
    case "get_updates": return done(await route("GET", "/stack/v1/updates"));
    case "get_settings": return { ok: true, text: clip(settingsText(String(args.prefix ?? "stack."))) };
    case "get_logs": return done(await route("GET", `/stack/v1/logs?tail=${Math.min(200, Math.max(1, Number(args.tail) || 50))}`));
    case "set_role_enabled": {
      const put = await route("PUT", "/stack/v1/settings", { [`stack.roles.${args.role}.enabled`]: args.enabled === true || args.enabled === "true" });
      if (put.status >= 400) return done(put);
      const applied = await route("POST", "/stack/v1/settings/apply", {});
      return applied.status >= 400 ? done(applied) : { ok: true, text: "Saved and applied." };
    }
    case "set_setting": {
      const key = String(args.key);
      const put = await route("PUT", "/stack/v1/settings", { [key]: coerceSetting(key, args.value) });
      if (put.status >= 400) return done(put);
      const applied = await route("POST", "/stack/v1/settings/apply", {});
      return applied.status >= 400 ? done(applied) : { ok: true, text: "Saved and applied." };
    }
    case "restart_engine": return done(await route("POST", `/stack/v1/engines/${enc(args.name)}/restart`));
    case "restart_stack": return done(await route("POST", "/stack/v1/service/restart"));
    case "check_updates": return done(await route("POST", "/stack/v1/updates/check", {}));
    case "apply_update": return done(await route("POST", `/stack/v1/updates/engines/${enc(args.name)}/apply`, {}));
    case "rollback_update": return done(await route("POST", `/stack/v1/updates/engines/${enc(args.name)}/rollback`, { tag: String(args.tag) }));
    default: return { ok: false, text: `There is no tool called ${tool.name}.` };
  }
}

// --- state --------------------------------------------------------------
const pending = new Map<string, Pending>();
function sweep(): void { const cut = Date.now() - PENDING_TTL_MS; for (const [id, p] of pending) if (Date.parse(p.at) < cut) pending.delete(id); }
export function listPending(): Pending[] { sweep(); return [...pending.values()]; }
export function __resetHelperForTests(): void { pending.clear(); clearHistory(); model = realModel; route = realRoute; }

export function readHistory(): ChatMessage[] {
  const row = db.select({ value: meta.value }).from(meta).where(eq(meta.key, HISTORY_KEY)).get();
  if (!row) return [];
  try { const parsed = JSON.parse(row.value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
function writeHistory(messages: ChatMessage[]): void {
  const value = JSON.stringify(messages.slice(-HISTORY_MAX));
  db.insert(meta).values({ key: HISTORY_KEY, value }).onConflictDoUpdate({ target: meta.key, set: { value } }).run();
}
export function clearHistory(): void { db.delete(meta).where(eq(meta.key, HISTORY_KEY)).run(); pending.clear(); }

function audit(event: string, extra: Record<string, string>): void {
  logger.appendLine(JSON.stringify({ event: `admin.action.helper.${event}`, at: new Date().toISOString(), source: "helper", approvedBy: "admin", ...extra }));
}

/** The page's own notices (an ask, a Done line) are shown in the chat but not fed back to the model, which would copy their wording into plain answers. */
const NOTICE = /^(I need your approval before|Done: |Okay, I did not do it|That did not work)/;
export function isNotice(message: ChatMessage): boolean { return message.role === "assistant" && NOTICE.test(message.content); }

export interface ChatResult { reply: string; pending: Pending[]; tools: string[]; wakeMs: number; }

function parseArgs(raw: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw !== "string") return raw;
  try { const parsed = JSON.parse(raw); return parsed && typeof parsed === "object" ? parsed : {}; } catch { return {}; }
}

/** One admin message in, one answer out. Read tools run inside; writes come back as pending approvals. */
export async function chat(text: string): Promise<ChatResult> {
  const history = readHistory();
  const now = () => new Date().toISOString();
  history.push({ role: "user", content: text, at: now() });
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: HELPER_SYSTEM_PROMPT },
    ...history.filter((m) => !isNotice(m)).slice(-12).map((m) => ({ role: m.role, content: m.content })),
  ];
  const used: string[] = [];
  let failed = false;
  let succeeded = false;
  const parked: Pending[] = [];
  const started = Date.now();
  let wakeMs = 0;
  let reply = "";
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const answer = await model({ model: "helper", temperature: 0, max_tokens: 400, messages, tools: helperToolSpecs() });
    if (round === 0) wakeMs = Date.now() - started;
    const calls = answer.message.tool_calls ?? [];
    if (calls.length === 0) { reply = cleanReply((answer.message.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, ""), failed, succeeded); break; }
    messages.push({ role: "assistant", content: answer.message.content ?? "", tool_calls: calls.map((c, i) => ({ id: c.id ?? `call_${round}_${i}`, type: "function", function: { name: c.function.name, arguments: typeof c.function.arguments === "string" ? c.function.arguments : JSON.stringify(c.function.arguments) } })) });
    for (const [i, call] of calls.entries()) {
      const id = call.id ?? `call_${round}_${i}`;
      const tool = helperTool(call.function.name);
      const args = parseArgs(call.function.arguments);
      let result: string;
      if (!tool) { failed = true; result = `There is no tool called ${call.function.name}.`; }
      else if (tool.kind === "read") {
        const outcome = await runTool(tool, args);
        if (outcome.ok) { used.push(tool.name); succeeded = true; result = outcome.text; }
        else { failed = true; result = `COULD NOT READ (${outcome.text.slice(0, 300)}). Try get_role_model or get_roles once, otherwise tell the admin plainly you could not read it. Do not repeat this text.`; }
      }
      else {
        const refusal = refuseWrite(tool.name, args);
        if (refusal) result = refusal;
        else {
          const p: Pending = { id: crypto.randomUUID(), tool: tool.name, args, summary: summarizeWrite(tool.name, args), at: now() };
          pending.set(p.id, p); parked.push(p);
          result = "Waiting for the administrator to click Approve. Nothing has changed yet.";
        }
      }
      messages.push({ role: "tool", tool_call_id: id, content: result });
    }
    if (parked.length > 0) {
      // The wording of an ask is fixed, never the model's: it must say plainly that nothing has changed yet.
      reply = `I need your approval before I change anything: ${parked.map((p) => p.summary).join("; ")}. Nothing has changed yet.`;
      break;
    }
  }
  if (!reply) reply = parked.length > 0 ? `I need your approval: ${parked.map((p) => p.summary).join("; ")}.` : "I could not put an answer together. Try asking a shorter question.";
  history.push({ role: "assistant", content: reply, at: now(), ...(used.length > 0 ? { tools: used } : {}) });
  writeHistory(history);
  return { reply, pending: parked, tools: used, wakeMs };
}

export type Decision = { ok: true; summary: string; result: string } | { ok: false; code: "not_found" | "failed"; error: string };

export async function approve(id: string): Promise<Decision> {
  sweep();
  const p = pending.get(id);
  if (!p) return { ok: false, code: "not_found", error: "That request is no longer waiting. Ask the Helper again." };
  pending.delete(id);
  const tool = helperTool(p.tool)!;
  audit("approved", { tool: p.tool, args: JSON.stringify(p.args).slice(0, 300) });
  const outcome = await runTool(tool, p.args);
  const history = readHistory();
  history.push({ role: "assistant", content: outcome.ok ? `Done: ${p.summary}.` : `That did not work (${p.summary}): ${outcome.text.slice(0, 300)}`, at: new Date().toISOString() });
  writeHistory(history);
  if (!outcome.ok) return { ok: false, code: "failed", error: outcome.text.slice(0, 400) };
  return { ok: true, summary: p.summary, result: outcome.text.slice(0, 600) };
}

export function deny(id: string): boolean {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  audit("denied", { tool: p.tool });
  const history = readHistory();
  history.push({ role: "assistant", content: `Okay, I did not do it: ${p.summary}.`, at: new Date().toISOString() });
  writeHistory(history);
  return true;
}
