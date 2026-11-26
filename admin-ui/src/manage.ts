// Pure helpers for the plan wording, Settings, Updates and Tools screens (model choices and priority live in the shared AI and models page).
// No React and no network, so tests/adminManage.test.ts can pin the wording and the maths.
import type { PlanRole, Setting, SettingValue, SettingsDoc } from "./api";

export function rebootAllowed(doc: SettingsDoc | null): boolean {
  return doc?.settings.find((s) => s.key === "stack.admin.allow_reboot")?.in_effect === true;
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

/** Settings that belong on the Settings screen: the role switches have their own screens. Secrets are shown, but only as a box to paste a new value into; the stored value never leaves the Stack. */
export function settingsForScreen(doc: SettingsDoc, showAdvanced: boolean): { id: string; label: string; items: Setting[] }[] {
  const keep = (s: Setting) => !s.key.startsWith("stack.roles.") && (showAdvanced || s.level === "basic");
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
