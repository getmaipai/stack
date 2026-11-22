// The Helper's read tools, written so a small model reads plain sentences: GB never bytes, feature names
// as the page shows them, tiers spelled out, and "installed" kept apart from "chosen". Each reader asks
// the same /stack/v1 routes the page uses, through the route door, and returns text. A failed route is
// an ok:false outcome the chat loop turns into a plain "could not read".
import type { Candidate, Category } from "@/lib/choicesSchema";
import { GLOSSARY, gb, lookupTerm, modelLabel, plainJson, resolveRole, roleExplain, roleLabel, TIER_NAMES, tierCategoryOf, type TierName } from "@/lib/helperKnowledge";
import type { RouteCall, ToolOutcome } from "@/lib/helperTools";
import { ROLE_IDS, ROLES, type RoleId } from "@/roles";
import { SETTINGS, settingValues } from "@/settings";

const SECRET_SETTING = /token|secret|password|key$|_key|cookie/i;
export { SECRET_SETTING };
const fail = (text: string): ToolOutcome => ({ ok: false, text });
const okText = (text: string): ToolOutcome => ({ ok: true, text });
const asRecord = (v: unknown): Record<string, any> => (v && typeof v === "object" ? (v as Record<string, any>) : {});

const TIER_MEANING: Record<TierName, string> = {
  reduced: "the small fallback that frees memory",
  standard: "the everyday size",
  boost: "bigger and better, uses more memory",
  max: "the biggest that fits this computer",
};

async function getJson(route: RouteCall, path: string): Promise<{ ok: true; json: Record<string, any> } | { ok: false; status: number }> {
  const r = await route("GET", path);
  return r.status < 400 ? { ok: true, json: asRecord(r.json) } : { ok: false, status: r.status };
}

interface RoleView { id: RoleId; label: string; enabled: boolean; priority: number; state?: { state?: string }; model?: { id: string; sizeBytes?: number | null } | null; models?: Array<{ id: string }>; coding?: { engine?: string; engine_reason?: string | null; state?: string }; tts?: { engine?: string }; plain_reason?: string | null }
async function loadRoles(route: RouteCall): Promise<RoleView[] | null> {
  const r = await getJson(route, "/stack/v1/roles");
  return r.ok && Array.isArray(r.json.roles) ? (r.json.roles as RoleView[]) : null;
}
const stateWord = (r: RoleView): string => {
  if (!r.enabled) return "turned off";
  switch (r.state?.state) {
    case "ready": case "loaded": case "busy": return "running";
    case "installed": return "installed, starts when asked";
    case "notInstalled": return "turned on, but no model is installed for it yet";
    case "loading": return "starting";
    case "offline": return "not answering";
    default: return r.state?.state ?? "unknown";
  }
};

/** `focus: "onoff"` (set by the reading step for "which features are on or off") adds the one-sentence lead; a question about one feature or its priority gets the plain list. */
export async function readRoles(route: RouteCall, args: { focus?: unknown } = {}): Promise<ToolOutcome> {
  const roles = await loadRoles(route);
  if (!roles) return fail("Could not read the features.");
  const off = roles.filter((r) => !r.enabled);
  const on = roles.filter((r) => r.enabled);
  return { ok: true, text: roles.map((r) => `${r.label} (${r.id}, ${roleExplain(r.id)}): ${stateWord(r)}; priority ${r.priority}; model ${r.model ? `${modelLabel(r.model.id)} (${r.model.id}${r.model.sizeBytes ? `, ${gb(r.model.sizeBytes)} file` : ""})` : "none installed"}.`).join("\n"),
    ...(args.focus === "onoff" ? { lead: `Turned on: ${on.map((r) => r.label).join(", ") || "nothing"}. Turned off: ${off.map((r) => r.label).join(", ") || "nothing"}.`, must: off.map((r) => r.label) } : {}) };
}

const CANDIDATE_STATE_WORDS: Record<Candidate["state"], string> = { installed: "INSTALLED", installing: "downloading", notInstalled: "not installed", failed: "install failed", unsupported: "not available on this Stack yet" };
const stateOf = (c: Candidate): string => (c.state === "installing" && c.percent !== null ? `downloading, ${Math.round(c.percent)} percent` : CANDIDATE_STATE_WORDS[c.state]);

/** The page's own read (`GET /stack/v1/choices`), so the Helper and the AI and models page name the same models in the same words. */
async function loadChoices(route: RouteCall): Promise<Category[] | null> {
  const r = await getJson(route, "/stack/v1/choices");
  return r.ok && Array.isArray(r.json.categories) ? (r.json.categories as Category[]) : null;
}

/** The choices category a feature belongs to: its own, or (judge and router) the chat category they share. */
function categoryOf(categories: Category[], role: RoleId): Category | null {
  return categories.find((c) => c.role === role) ?? categories.find((c) => c.id === tierCategoryOf(role)) ?? null;
}

const levelWord = (tier: string): string => `${tier[0]!.toUpperCase()}${tier.slice(1)}`;

export async function readModels(route: RouteCall, args: { role?: unknown; tier?: unknown }): Promise<ToolOutcome> {
  const resolved = resolveRole(args.role ?? "chat");
  if (!resolved.ok) return fail(resolved.reason);
  const role = resolved.role;
  const roles = await loadRoles(route);
  if (!roles) return fail("Could not read the features.");
  const view = roles.find((r) => r.id === role)!;
  const choices = await loadChoices(route);
  if (!choices) return fail("Could not read the models.");
  const category = categoryOf(choices, role);
  const wantTier = TIER_NAMES.includes(String(args.tier ?? "").toLowerCase() as TierName) ? (String(args.tier).toLowerCase() as TierName) : null;
  const lines: string[] = [];

  lines.push(`${view.label} (${role}) is ${stateWord(view)}. It is a ${ROLES[role].residency === "resident" ? "always-loaded" : "load-when-asked"} feature (${roleExplain(role)}).`);
  lines.push(view.model ? `Running right now: ${modelLabel(view.model.id)} (${view.model.id}).` : "Running right now: none, because none is installed for it.");
  if (role === "coding" && view.coding) lines.push(`Coding engine: ${view.coding.engine}${view.coding.engine_reason ? ` (${view.coding.engine_reason})` : ""}.`);
  if (role === "tts" && view.tts) lines.push(`Voice engine in use: ${view.tts.engine}.`);
  if (!category) {
    lines.push(`The Stack lists no models for ${view.label}.`);
    return okText(lines.join("\n"));
  }

  const rows = [...category.tiers].sort((a, b) => TIER_NAMES.indexOf(a.tier as TierName) - TIER_NAMES.indexOf(b.tier as TierName));
  const labelById = new Map(category.candidates.map((c) => [c.id, c.label]));
  const chosenAt = (id: string): string[] => rows.filter((row) => row.chosen === id).map((row) => levelWord(row.tier));
  lines.push(`Models this Stack offers for ${view.label}, as the AI and models page shows them:`);
  for (const c of category.candidates) {
    const at = chosenAt(c.id);
    lines.push(`- ${c.label} (${c.id}): ${[c.version ? `version ${c.version}` : null, c.quantization, c.license, `engine ${c.engine ?? "unknown"}`].filter(Boolean).join(", ")}; about ${gb(c.size_bytes)} on disk; ${stateOf(c)}${at.length > 0 ? `; CHOSEN for ${at.join(" and ")}` : ""}${c.enabled ? "" : "; switched off in the order"}. ${c.summary}`);
  }

  if (category.tiered) {
    lines.push(`Levels for ${category.label} on this computer (a level is how big a model it may use):`);
    if (!wantTier || wantTier === "reduced") lines.push(`- Reduced: ${TIER_MEANING.reduced}.`);
    for (const row of rows) {
      if (wantTier && row.tier !== wantTier) continue;
      const fitting = row.options.filter((o) => o.fits).map((o) => `${labelById.get(o.model) ?? o.model}`);
      const chosen = row.chosen ? `${labelById.get(row.chosen) ?? row.chosen}${row.chosen_by === "household" ? " (chosen by the household)" : row.chosen_by === "recommended" ? " (the recommended one)" : ""}` : row.chosen_by === "off" ? "switched off" : "none fits";
      const meaning = TIER_MEANING[row.tier as TierName];
      lines.push(`- ${levelWord(row.tier)} (${meaning ? `${meaning}; ` : ""}${row.cap_bytes ? `up to ${gb(row.cap_bytes)}` : "no memory cap"}): uses ${chosen}. Fits: ${fitting.length > 0 ? fitting.join(", ") : "nothing"}.${row.problem ? ` Problem: ${row.problem}` : ""}`);
    }
  } else if (wantTier) {
    const names = category.candidates.map((c) => `${c.label} (${c.state === "installed" ? "installed" : "not installed"}${chosenAt(c.id).length > 0 ? ", chosen" : ""})`).join(" and ");
    lines.push(`Note: ${view.label} has no Reduced, Standard, Boost or Max ladder. The models above are all it has.`);
    return { ok: true, text: lines.join("\n"), lead: `${view.label} has no ${levelWord(wantTier)} tier, because tiers exist only for chat, pictures, video, music and voice. Its models are ${names || "none yet"}.`, must: [/\bno\b|does not|doesn.t|isn.t|not have/i] };
  } else {
    lines.push(`Note: ${view.label} has no level ladder; the models above are all it has.`);
  }
  return okText(lines.join("\n"));
}

const PROGRAMS: Record<string, string> = {
  splash: "Splash, the fast Apple-silicon engine for chat and coding. Its memory is the model it holds plus a conversation cache",
  "splash-chat": "Splash serving chat",
  "llama-server": "llama-server, the engine that runs GGUF model files",
  python: "a Python worker (pictures, music or voice)",
  bun: "the Stack's own program",
  node: "a program that is not the Stack's",
};

export async function readMemory(route: RouteCall, args: { name?: unknown } = {}): Promise<ToolOutcome> {
  const m = await getJson(route, "/stack/v1/memory");
  if (!m.ok) return fail("Could not read memory.");
  const mem = asRecord(m.json.memory);
  const ledger = asRecord(m.json.ledger);
  const lines: string[] = [];
  lines.push(`Memory: ${gb(mem.total_bytes)} in the computer, ${gb(mem.available_bytes)} available, pressure ${mem.pressure}.`);
  lines.push(`The Stack may use ${gb(ledger.budget_bytes)} for models; loaded models hold ${gb(Number(ledger.warm_bytes ?? 0) + Number(ledger.reserved_bytes ?? 0))} now.`);
  const seen = new Set<number>();
  const rows: Array<{ pid: number; name: string; bytes: number }> = [];
  for (const p of [...(asRecord(m.json.stack).processes ?? []), ...(m.json.top_consumers ?? [])] as Array<{ pid: number; name: string; bytes: number; stack?: boolean }>) {
    if (seen.has(p.pid) || p.stack === false || p.bytes < 300_000_000) continue;
    seen.add(p.pid); rows.push(p);
  }
  rows.sort((a, b) => b.bytes - a.bytes);
  const items = Array.isArray(ledger.items) ? (ledger.items as Array<{ id: string; live_bytes: number }>) : [];
  const want = String(args.name ?? "").toLowerCase().trim();
  const shown = want ? rows.filter((r) => r.name.toLowerCase().includes(want)) : rows.slice(0, 6);
  if (want && shown.length === 0) lines.push(`${want} is not holding any memory right now (it is not running, or is under 0.3 GB).`);
  else if (shown.length > 0) lines.push(`Programs the Stack runs, biggest first:\n${shown.map((r) => `- ${r.name}: ${gb(r.bytes)}. That is ${PROGRAMS[r.name.toLowerCase()] ?? "a program"}.`).join("\n")}`);
  if (items.length > 0) lines.push(`Features holding memory now: ${items.map((i) => `${roleLabel(i.id)} ${gb(i.live_bytes)}`).join(", ")}.`);
  return okText(lines.join("\n"));
}

/** Why one engine holds the memory it does: what it is, which features and models it serves, what else it keeps, and what lowers it. */
export async function readEngineUse(route: RouteCall, args: { name?: unknown }): Promise<ToolOutcome> {
  const name = String(args.name ?? "").toLowerCase().trim();
  if (!name) return fail("Say which engine.");
  const entry = lookupTerm(name);
  const lines: string[] = [];
  if (entry) lines.push(`${name}: ${entry.meaning}`);
  const mem = await readMemory(route, { name });
  if (mem.ok) lines.push(mem.text.split("\n").filter((l) => l.startsWith("-") || l.includes("not holding")).join("\n"));
  const held = /^- [^:]+: ([\d.]+) GB/m.exec(mem.ok ? mem.text : "");
  const headroom = name === "splash" ? ` The setting Chat memory headroom caps that cache at ${settingValues()["stack.engines.chat.max_memory_headroom_gb"] ?? 12} GB; lowering it, or using a smaller tier, uses less memory.` : "";
  const lead = held ? `${name[0]!.toUpperCase()}${name.slice(1)} is an engine, not a model or a tier. It is holding ${held[1]} GB right now, mostly the model it keeps loaded plus a conversation cache.${headroom}` : undefined;
  const must = held ? [/\bengine\b/i, new RegExp(`\\b(${Number(held[1]).toFixed(1)}|${Math.round(Number(held[1]))})\\s*GB`)] : undefined;
  const roles = await loadRoles(route);
  const values = settingValues();
  if (roles) {
    const serving: string[] = [];
    const chatEngine = String(values["stack.engines.chat.engine"] ?? "auto");
    const codingEngine = roles.find((r) => r.id === "coding")?.coding?.engine;
    if (name === "splash") {
      if (chatEngine === "splash") { const c = roles.find((r) => r.id === "chat"); serving.push(`Chat${c?.model ? ` (${modelLabel(c.model.id)}${c.model.sizeBytes ? `, ${gb(c.model.sizeBytes)} file` : ""})` : ""}`); }
      if (codingEngine === "splash") { const c = roles.find((r) => r.id === "coding"); serving.push(`Coding${c?.model ? ` (${modelLabel(c.model.id)})` : ""}`); }
      lines.push(serving.length > 0 ? `Splash is set to serve: ${serving.join(" and ")}.` : "No feature is set to use Splash right now.");
      lines.push(`Besides the model, Splash keeps a conversation cache. The setting Chat memory headroom (stack.engines.chat.max_memory_headroom_gb) is ${values["stack.engines.chat.max_memory_headroom_gb"] ?? 12} GB, the most extra room that cache may take. Lowering it, picking a smaller tier, or setting the chat engine to llama-server uses less memory.`);
    } else if (name === "llama-server") {
      lines.push(`llama-server serves the Helper${chatEngine === "auto" || chatEngine === "llama-server" ? ", chat" : ""}${codingEngine === "llama-server" ? " and coding" : ""}.`);
    }
  }
  return lines.length > 0 ? { ok: true, text: lines.join("\n"), lead, must } : fail("Could not read that engine.");
}

export async function readHealth(route: RouteCall): Promise<ToolOutcome> {
  const r = await getJson(route, "/stack/v1/health");
  if (!r.ok) return fail("Could not read health.");
  const items = (r.json.health ?? []) as Array<{ plain?: string; fix?: string | { label?: string } | null }>;
  if (items.length === 0) return okText("Healthy: the Stack sees no problems.");
  return okText(`${items.length} problem${items.length === 1 ? "" : "s"}:\n${items.map((i) => `- ${i.plain ?? "Unknown problem"}`).join("\n")}`);
}

export async function readHardware(route: RouteCall): Promise<ToolOutcome> {
  const r = await getJson(route, "/stack/v1/hardware");
  if (!r.ok) return fail("Could not read the hardware.");
  const h = asRecord(r.json.hardware);
  const p = asRecord(r.json.proposed);
  return okText(`This computer: ${h.arch === "arm64" ? "Apple silicon" : h.arch}, ${h.unifiedMemoryGb ?? h.totalRamGb} GB memory, ${h.cpuCount} cores, ${gb(Number(h.freeDiskBytes ?? 0))} disk free. Memory class (profile): ${String(p.id ?? "unknown").toUpperCase()}. ${p.label ?? ""}`);
}

export async function readUpdates(route: RouteCall): Promise<ToolOutcome> {
  const r = await getJson(route, "/stack/v1/updates");
  if (!r.ok) return fail("Could not read updates.");
  const engines = (r.json.engines ?? []) as Array<{ name: string; installed?: string | null; available?: string | null; lastChecked?: string | null }>;
  const lines = engines.map((e) => `${e.name}: installed ${e.installed ?? "none"}${e.available ? `, newer ${e.available} available` : ", no newer build known"}${e.lastChecked ? `, last checked ${e.lastChecked}` : ", never checked"}.`);
  return okText(`Update checks are ${r.json.checksEnabled ? "on" : "off"}.\n${lines.join("\n")}`);
}

export function readSettings(prefix: string): ToolOutcome {
  const values = settingValues();
  const rows = SETTINGS.filter((s) => s.key.startsWith(prefix) && !SECRET_SETTING.test(s.key));
  if (rows.length > 0) return okText(rows.slice(0, 40).map((s) => `${s.label} (${s.key}) = ${String(values[s.key] ?? s.default)}`).join("\n"));
  const prefixes = [...new Set(SETTINGS.filter((x) => !SECRET_SETTING.test(x.key)).map((x) => x.key.split(".").slice(0, 3).join(".")))].slice(0, 40);
  return fail(`No setting starts with "${prefix}". Real prefixes: ${prefixes.join(", ")}.`);
}

export async function readLogs(route: RouteCall, tail: number): Promise<ToolOutcome> {
  const r = await route("GET", `/stack/v1/logs?tail=${Math.min(200, Math.max(1, tail || 50))}`);
  if (r.status >= 400) return fail("Could not read the log.");
  const text = typeof r.json === "string" ? r.json : JSON.stringify(plainJson(r.json));
  return okText(text.length > 2800 ? `${text.slice(0, 2800)}\n[cut]` : text);
}

export function explainTerm(term: string): ToolOutcome {
  const entry = lookupTerm(term);
  if (entry) return okText(`${entry.term}: ${entry.meaning}`);
  return okText(`No glossary entry for "${term}". The terms are: ${GLOSSARY.map((g) => g.term).join(", ")}.`);
}

/** Every role id, for error text that needs the real names. */
export const REAL_ROLES = ROLE_IDS.join(", ");
