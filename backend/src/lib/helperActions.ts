// Helper actions: the model only PROPOSES one typed action. The server turns the proposal into a
// card (a plain sentence, the current value and the new value), keeps it by id, and runs it only when
// the admin confirms that exact proposal: not expired, not used, not edited, and on the allow-list below.
// Running means calling the same /stack/v1 routes the page uses, in process, with the stored parameters,
// never the posted ones. Reboot, removing a model and anything not listed here are not offered.
import { SETTINGS, settingValues } from "@/settings";
import { resolveRole, roleExplain, roleLabel } from "@/lib/helperKnowledge";
import { SECRET_SETTING } from "@/lib/helperReads";
import type { RouteCall } from "@/lib/helperTools";
import { gb } from "@/lib/helperKnowledge";
import { ROLE_PRIORITY_MAX, ROLE_PRIORITY_MIN } from "@/lib/roleSwitches";
import { type RoleId } from "@/roles";

export const ACTION_NAMES = ["set_role_enabled", "set_role_priority", "apply_profile", "restart_engine", "restart_stack", "set_setting", "check_updates", "apply_update", "rollback_update"] as const;
export type ActionName = (typeof ACTION_NAMES)[number];
export type ParamValue = string | number | boolean;
export interface Change { label: string; from: string; to: string }
export interface Proposal {
  id: string; action: ActionName; params: Record<string, ParamValue>; summary: string; changes: Change[];
  /** What else happens that the from and to lines do not show (a restart, a download). */
  note: string | null; at: string; expires_at: string;
}
export type ProposeOutcome =
  | { ok: true; proposal: Omit<Proposal, "id" | "at" | "expires_at"> }
  | { ok: false; kind: "ambiguous" | "noop" | "refused" | "invalid"; message: string };

export const PROPOSAL_TTL_MS = 10 * 60_000;
const ENGINE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const BUILD_TAG = /^[A-Za-z0-9._-]{1,64}$/;
const bad = (kind: "ambiguous" | "noop" | "refused" | "invalid", message: string): ProposeOutcome => ({ ok: false, kind, message });
const asRecord = (v: unknown): Record<string, any> => (v && typeof v === "object" ? (v as Record<string, any>) : {});
const onOff = (v: unknown) => (v ? "on" : "off");
const boolOf = (v: unknown): boolean | null => (v === true || v === "true" ? true : v === false || v === "false" ? false : null);

async function roleViews(route: RouteCall): Promise<Array<Record<string, any>> | null> {
  const r = await route("GET", "/stack/v1/roles");
  return r.status < 400 && Array.isArray(asRecord(r.json).roles) ? asRecord(r.json).roles : null;
}

function coerceSetting(key: string, raw: unknown): ParamValue | { error: string } {
  const declaration = SETTINGS.find((s) => s.key === key)!;
  if (declaration.selector === "boolean") { const b = boolOf(raw); return b === null ? { error: `${declaration.label} is on or off. Use true or false.` } : b; }
  if (declaration.selector === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { error: `${declaration.label} needs a number.` };
    const range = declaration.range as { min?: number; max?: number } | undefined;
    if (range?.min !== undefined && n < range.min) return { error: `${declaration.label} cannot be below ${range.min}.` };
    if (range?.max !== undefined && n > range.max) return { error: `${declaration.label} cannot be above ${range.max}.` };
    return n;
  }
  if (declaration.selector === "select") {
    const options = ((declaration.range as { options?: Array<{ value: string }> } | undefined)?.options ?? []).map((o) => o.value);
    return options.includes(String(raw)) ? String(raw) : { error: `${declaration.label} must be one of: ${options.join(", ")}.` };
  }
  return String(raw);
}

/** The engine that serves a role, for "restart the X engine". Null when there is no single engine to restart. */
function engineForRole(role: RoleId, views: Array<Record<string, any>>): string | null {
  const view = views.find((v) => v.id === role);
  const chatSetting = String(settingValues()["stack.engines.chat.engine"] ?? "auto");
  switch (role) {
    case "tts": return view?.tts?.engine ?? null;
    case "coding": return view?.coding?.engine ?? null;
    case "chat": case "judge": case "router": return chatSetting === "splash" ? "splash-chat" : chatSetting === "auto" ? "llama-server" : chatSetting;
    case "helper": return "llama-server";
    case "image": return "image-gen";
    case "music": return "music-gen";
    default: return null;
  }
}

/** Reads the state, checks every parameter and says exactly what would change. Never changes anything. */
export async function buildProposal(route: RouteCall, action: string, raw: Record<string, unknown>): Promise<ProposeOutcome> {
  if (!(ACTION_NAMES as readonly string[]).includes(action)) return bad("refused", `"${action}" is not something the Helper offers. Rebooting the computer and removing models are done on the Tools or Models screen.`);
  switch (action as ActionName) {
    case "set_role_enabled": {
      const role = resolveRole(raw.role);
      if (!role.ok) return bad("ambiguous", role.reason);
      if (role.role === "helper") return bad("refused", "The Helper cannot switch itself off. Use the Features screen.");
      const enabled = boolOf(raw.enabled);
      if (enabled === null) return bad("invalid", "Say whether to turn it on or off.");
      const views = await roleViews(route);
      if (!views) return bad("invalid", "Could not read the features just now.");
      const view = views.find((v) => v.id === role.role)!;
      if (Boolean(view.enabled) === enabled) return bad("noop", `${view.label} is already ${onOff(enabled)}. Nothing to change.`);
      return { ok: true, proposal: { action: "set_role_enabled", params: { role: role.role, enabled }, summary: `Turn ${view.label} ${onOff(enabled)}`, changes: [{ label: `${view.label} (${roleExplain(role.role)})`, from: onOff(view.enabled), to: onOff(enabled) }], note: enabled ? "It starts the next time it is used." : "A running engine for it is stopped and its work is refused until you turn it back on." } };
    }
    case "set_role_priority": {
      const role = resolveRole(raw.role);
      if (!role.ok) return bad("ambiguous", role.reason);
      const views = await roleViews(route);
      if (!views) return bad("invalid", "Could not read the features just now.");
      const view = views.find((v) => v.id === role.role)!;
      const current = Number(view.priority);
      let target: number;
      let how: string;
      const other = raw.above !== undefined ? ({ side: "above", r: resolveRole(raw.above) } as const) : raw.below !== undefined ? ({ side: "below", r: resolveRole(raw.below) } as const) : null;
      if (other) {
        if (!other.r.ok) return bad("ambiguous", other.r.reason);
        const ov = views.find((v) => v.id === (other.r as { role: RoleId }).role)!;
        if (ov.id === view.id) return bad("invalid", "A feature cannot be placed above or below itself.");
        const op = Number(ov.priority);
        if (other.side === "above") {
          if (current < op) return bad("noop", `${view.label} is already served before ${ov.label} (priority ${current} against ${op}).`);
          if (op <= ROLE_PRIORITY_MIN) return bad("refused", `${ov.label} is already at the top number (${op}), so nothing can be placed before it with one change. Set it by hand on the Settings screen.`);
          target = op - 1; how = `before ${ov.label}`;
        } else {
          if (current > op) return bad("noop", `${view.label} is already served after ${ov.label} (priority ${current} against ${op}).`);
          if (op >= ROLE_PRIORITY_MAX) return bad("refused", `${ov.label} is already at the lowest priority.`);
          target = op + 1; how = `after ${ov.label}`;
        }
      } else if (raw.priority !== undefined || raw.value !== undefined) {
        target = Math.round(Number(raw.priority ?? raw.value));
        if (!Number.isFinite(target) || target < ROLE_PRIORITY_MIN || target > ROLE_PRIORITY_MAX) return bad("invalid", `Priority is a whole number from ${ROLE_PRIORITY_MIN} to ${ROLE_PRIORITY_MAX}; a lower number is served first.`);
        how = `at priority ${target}`;
      } else return bad("invalid", "Say which feature it should go above or below, or give a priority number.");
      if (target === current) return bad("noop", `${view.label} already has priority ${current}.`);
      return { ok: true, proposal: { action: "set_role_priority", params: { role: role.role, priority: target }, summary: `Serve ${view.label} ${how} when work waits for memory`, changes: [{ label: `${view.label} priority (lower is served first)`, from: String(current), to: String(target) }], note: null } };
    }
    case "apply_profile": {
      const mode = raw.mode === "matched" ? "matched" : "custom_recommended";
      const rec = await route("POST", "/stack/v1/profiles/recommend", {});
      if (rec.status >= 400) return bad("invalid", "Could not work out the recommended setup just now.");
      const body = asRecord(rec.json);
      const plan = mode === "matched" ? null : body.custom_recommended?.plan;
      if (mode === "matched" && !body.matched) return bad("refused", "No ready-made profile matches this computer closely. Ask for the recommended profile instead.");
      if (mode === "custom_recommended" && !plan) return bad("refused", "This computer is too small for any profile.");
      const views = (await roleViews(route)) ?? [];
      const changes: Change[] = [];
      for (const pr of (plan?.roles ?? []) as Array<{ role: RoleId; enabled: boolean; priority: number }>) {
        const v = views.find((x) => x.id === pr.role);
        if (!v) continue;
        if (Boolean(v.enabled) !== pr.enabled) changes.push({ label: roleLabel(pr.role), from: onOff(v.enabled), to: onOff(pr.enabled) });
        else if (Number(v.priority) !== pr.priority) changes.push({ label: `${roleLabel(pr.role)} priority`, from: String(v.priority), to: String(pr.priority) });
      }
      const label = mode === "matched" ? `the ready-made ${String(body.matched.tier).toUpperCase()} profile` : `the recommended setup for this ${plan ? gb(Number(plan.budget?.total_bytes ?? 0)) : ""} computer`.replace("  ", " ");
      return { ok: true, proposal: { action: "apply_profile", params: { mode }, summary: `Apply ${label}`, changes: changes.slice(0, 12), note: `${changes.length === 0 ? "No feature switches or priorities change. " : changes.length > 12 ? `${changes.length - 12} more changes are not shown. ` : ""}Any pinned model it needs that is not installed starts downloading.` } };
    }
    case "restart_engine": {
      const target = String(raw.name ?? raw.role ?? "").trim();
      if (!target) return bad("invalid", "Say which engine or feature to restart.");
      const listed = await route("GET", "/stack/v1/engines");
      const names = [...new Set(((asRecord(listed.json).engines ?? []) as Array<{ name: string }>).map((e) => e.name))];
      let name = names.find((n) => n.toLowerCase() === target.toLowerCase()) ?? null;
      let via = "";
      if (!name) {
        const role = resolveRole(target);
        if (!role.ok) return bad("ambiguous", role.reason);
        const views = (await roleViews(route)) ?? [];
        name = engineForRole(role.role, views);
        if (!name || !names.includes(name)) return bad("refused", `${roleLabel(role.role)} has no single engine the Helper can restart. Restart the whole Stack, or use the Engines screen.`);
        via = ` (${roleLabel(role.role)})`;
      }
      const running = ((asRecord(listed.json).engines ?? []) as Array<{ name: string; running?: boolean }>).some((e) => e.name === name && e.running);
      return { ok: true, proposal: { action: "restart_engine", params: { name }, summary: `Restart the ${name} engine${via}`, changes: [{ label: `${name} engine`, from: running ? "running" : "not running", to: "restarted" }], note: "Work in progress on it is interrupted for a few seconds." } };
    }
    case "restart_stack":
      return { ok: true, proposal: { action: "restart_stack", params: {}, summary: "Restart the Stack", changes: [{ label: "The Stack", from: "running", to: "restarting" }], note: "Everything stops for about 10 seconds. This page reconnects by itself." } };
    case "set_setting": {
      const key = String(raw.key ?? "");
      const declaration = SETTINGS.find((s) => s.key === key);
      if (!declaration) return bad("invalid", `There is no setting called "${key}". Look up the real names first.`);
      if (key.startsWith("stack.admin.") || SECRET_SETTING.test(key)) return bad("refused", "The Helper may not change admin, sign-in or secret settings. Change it by hand on the Settings screen.");
      const value = coerceSetting(key, raw.value);
      if (typeof value === "object") return bad("invalid", value.error);
      const current = settingValues()[key] ?? declaration.default;
      if (String(current) === String(value)) return bad("noop", `${declaration.label} is already ${String(value)}.`);
      return { ok: true, proposal: { action: "set_setting", params: { key, value }, summary: `Change ${declaration.label}`, changes: [{ label: `${declaration.label} (${key})`, from: String(current), to: String(value) }], note: declaration.needs_restart ? "It takes effect after the next restart of that engine or the Stack." : null } };
    }
    case "check_updates":
      return { ok: true, proposal: { action: "check_updates", params: {}, summary: "Check the catalog for newer engine builds", changes: [], note: "It only looks. Nothing is installed." } };
    case "apply_update": {
      const name = String(raw.name ?? "");
      if (!ENGINE_NAME.test(name)) return bad("invalid", "Give the engine name.");
      const upd = await route("GET", "/stack/v1/updates");
      const entry = ((asRecord(upd.json).engines ?? []) as Array<{ name: string; installed?: string | null; available?: string | null }>).find((e) => e.name === name);
      if (!entry) return bad("invalid", `There is no engine called "${name}" in the update list.`);
      if (!entry.available) return bad("noop", `No newer ${name} build is known. Check for updates first.`);
      return { ok: true, proposal: { action: "apply_update", params: { name }, summary: `Install the newer ${name} build`, changes: [{ label: `${name} build`, from: entry.installed ?? "none", to: entry.available }], note: "The old build is kept so you can go back." } };
    }
    case "rollback_update": {
      const name = String(raw.name ?? ""); const tag = String(raw.tag ?? "");
      if (!ENGINE_NAME.test(name) || !BUILD_TAG.test(tag)) return bad("invalid", "Give the engine name and the build to go back to.");
      const upd = await route("GET", "/stack/v1/updates");
      const entry = ((asRecord(upd.json).engines ?? []) as Array<{ name: string; installed?: string | null }>).find((e) => e.name === name);
      return { ok: true, proposal: { action: "rollback_update", params: { name, tag }, summary: `Go back to ${name} build ${tag}`, changes: [{ label: `${name} build`, from: entry?.installed ?? "unknown", to: tag }], note: null } };
    }
  }
}

/** The one place a proposal turns into calls on existing routes. Reads only the stored, validated parameters. */
export async function runProposal(route: RouteCall, p: Pick<Proposal, "action" | "params">): Promise<{ ok: boolean; text: string }> {
  const enc = (v: unknown) => encodeURIComponent(String(v));
  const done = (r: { status: number; json: unknown }, okText = "Done."): { ok: boolean; text: string } => {
    const body = asRecord(r.json);
    if (r.status >= 400) return { ok: false, text: `The Stack answered ${r.status}: ${String(body.error ?? JSON.stringify(r.json)).slice(0, 300)}` };
    if (body.ok === false) return { ok: false, text: String(body.reason ?? "The Stack did not do it.") };
    return { ok: true, text: okText };
  };
  const saveAndApply = async (values: Record<string, unknown>) => {
    const put = await route("PUT", "/stack/v1/settings", values);
    if (put.status >= 400) return done(put);
    return done(await route("POST", "/stack/v1/settings/apply", {}), "Saved and applied.");
  };
  switch (p.action) {
    case "set_role_enabled": return saveAndApply({ [`stack.roles.${p.params.role}.enabled`]: p.params.enabled });
    case "set_role_priority": return saveAndApply({ [`stack.roles.${p.params.role}.priority`]: p.params.priority });
    case "set_setting": return saveAndApply({ [String(p.params.key)]: p.params.value });
    case "apply_profile": return done(await route("POST", "/stack/v1/profiles/apply", { mode: p.params.mode }), "Applied.");
    case "restart_engine": return done(await route("POST", `/stack/v1/engines/${enc(p.params.name)}/restart`), "Restarted.");
    case "restart_stack": return done(await route("POST", "/stack/v1/service/restart"), "Restarting.");
    case "check_updates": return done(await route("POST", "/stack/v1/updates/check", {}), "Checked.");
    case "apply_update": return done(await route("POST", `/stack/v1/updates/engines/${enc(p.params.name)}/apply`, {}), "Installed.");
    case "rollback_update": return done(await route("POST", `/stack/v1/updates/engines/${enc(p.params.name)}/rollback`, { tag: String(p.params.tag) }), "Rolled back.");
  }
}

/** Two parameter sets are the same when every key and value match, whatever the order or the number-or-string spelling. */
export function sameParams(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a).sort(); const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && String(a[k]) === String(b[k]));
}
