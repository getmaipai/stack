// Pure helpers for the Features, Models, Settings, Updates and Tools screens.
// No React and no network, so tests/adminManage.test.ts can pin the wording and the maths.
import type { CatalogModel, InstalledModel, PlanRole, Setting, SettingValue, SettingsDoc } from "./api";

/** Lower number is served first when work waits for memory (ADMIN-04). */
export function byPriority<T extends { id: string; priority?: number }>(roles: T[]): T[] {
  return roles.map((r, i) => ({ r, i })).sort((a, b) => (a.r.priority ?? 100) - (b.r.priority ?? 100) || a.i - b.i).map((x) => x.r);
}

/** The settings to write so `id` moves one place up or down. Everything is renumbered 10, 20, 30 so ties (the default 100 for all) become a real order. Only changed keys are returned. */
export function movePriority(roles: { id: string; priority?: number }[], id: string, dir: -1 | 1): Record<string, number> {
  const order = byPriority(roles).map((r) => r.id);
  const from = order.indexOf(id);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= order.length) return {};
  [order[from], order[to]] = [order[to]!, order[from]!];
  const changes: Record<string, number> = {};
  for (const [i, role] of order.entries()) {
    const next = (i + 1) * 10;
    if (roles.find((r) => r.id === role)?.priority !== next) changes[`stack.roles.${role}.priority`] = next;
  }
  return changes;
}

export function rebootAllowed(doc: SettingsDoc | null): boolean {
  return doc?.settings.find((s) => s.key === "stack.admin.allow_reboot")?.in_effect === true;
}

export function catalogForRole(catalog: CatalogModel[], role: string): CatalogModel[] {
  return catalog.filter((m) => m.role === role && !!m.download?.url).sort((a, b) => (a.sizing?.profile ?? "").localeCompare(b.sizing?.profile ?? "") || a.id.localeCompare(b.id));
}

export function installedState(id: string, installed: InstalledModel[]): "missing" | "installed" | "loaded" {
  const m = installed.find((x) => x.id === id);
  if (!m || m.state !== "installed" || m.fileMissing) return "missing";
  return m.runtimeState === "loaded" ? "loaded" : "installed";
}

const FIT_WORDS: Record<PlanRole["fit"], string> = {
  fits: "Fits", queues: "Waits its turn when memory is tight", refused: "Does not fit on this computer", "n/a": "Not counted",
};
const STATE_WORDS: Record<PlanRole["state"], string> = {
  resident: "Stays in memory", on_demand: "Loads when asked", installed: "Installed, loads when asked", shared: "Shares the chat model", off: "Turned off", unavailable: "Not available at this size",
};
export function fitWord(f: PlanRole["fit"]): string { return FIT_WORDS[f]; }
export function planStateWord(s: PlanRole["state"]): string { return STATE_WORDS[s]; }

export const MODE_WORDS = {
  matched: { title: "Matched", text: "The ready-made setup for this computer's memory." },
  custom_recommended: { title: "Custom, recommended", text: "The Stack fits your own on and off choices into the memory you have." },
  custom: { title: "Custom", text: "Your own choices, checked for fit." },
} as const;

/** Settings that belong on the Settings screen: the role switches have their own screens, and secrets are never shown. */
export function settingsForScreen(doc: SettingsDoc, showAdvanced: boolean): { id: string; label: string; items: Setting[] }[] {
  const keep = (s: Setting) => !s.key.startsWith("stack.roles.") && !s.secret && (showAdvanced || s.level === "basic");
  return doc.sections
    .map((sec) => ({ id: sec.id, label: sec.label, items: doc.settings.filter((s) => s.section.id === sec.id && keep(s)).sort((a, b) => a.section.order - b.section.order) }))
    .filter((g) => g.items.length > 0);
}

export function settingValue(s: Setting, draft: Record<string, SettingValue>): SettingValue {
  return s.key in draft ? draft[s.key]! : s.pending ?? s.in_effect;
}

/** Turn what was typed into the declared type, or say in plain words what is wrong. */
export function coerce(s: Setting, raw: string): { value: SettingValue } | { error: string } {
  if (s.selector !== "number") return { value: raw };
  if (raw.trim() === "" || !/^-?\d+$/.test(raw.trim())) return { error: "Type a whole number." };
  const n = Number(raw);
  const { min, max } = s.range ?? {};
  if (min !== undefined && n < min) return { error: `The lowest allowed is ${min}.` };
  if (max !== undefined && n > max) return { error: `The highest allowed is ${max}.` };
  return { value: n };
}

export function pendingKeys(doc: SettingsDoc | null): string[] {
  return doc ? doc.settings.filter((s) => s.pending !== null && s.pending !== undefined && s.pending !== s.in_effect).map((s) => s.key) : [];
}

export function readinessWord(ok: boolean, skipped?: boolean): string { return skipped ? "Skipped" : ok ? "Passed" : "Failed"; }
