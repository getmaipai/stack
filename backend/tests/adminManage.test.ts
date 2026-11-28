// The plan wording, Settings, Updates and Tools screens' pure helpers (admin-ui/src/manage.ts):
// the reboot switch, plain-words wording and setting input checks. Model choices and priority are the shared page's (@maipai/ui).
import { expect, test } from "bun:test";
import { coerce, fitWord, pendingKeys, planStateWord, rebootAllowed, settingValue, settingsForScreen } from "../../admin-ui/src/manage";
import type { Setting, SettingsDoc } from "../../admin-ui/src/api";

const setting = (over: Partial<Setting>): Setting => ({
  key: "stack.x", selector: "number", label: "X", help: "", range: { min: 1, max: 100 }, default: 1, section: { id: "a", order: 1 }, level: "basic", needs_restart: false, in_effect: 1, pending: null, ...over,
});

test("reboot is offered only when the declared setting is on", () => {
  const doc = (v: boolean): SettingsDoc => ({ sections: [], settings: [setting({ key: "stack.admin.allow_reboot", selector: "boolean", in_effect: v })] });
  expect(rebootAllowed(doc(true))).toBe(true);
  expect(rebootAllowed(doc(false))).toBe(false);
  expect(rebootAllowed(null)).toBe(false);
});

test("fit decisions are said in plain words", () => {
  expect(fitWord("refused")).toBe("Does not fit on this computer");
  expect(fitWord("queues")).toContain("tight");
  expect(planStateWord("on_demand")).toBe("Loads when asked");
  expect(planStateWord("off")).toBe("Turned off");
});

test("settings screen hides role switches, shows secrets (as a box to paste a new value), and basic-only unless advanced", () => {
  const doc: SettingsDoc = {
    sections: [{ id: "a", label: "A" }, { id: "roles", label: "Roles" }, { id: "empty", label: "Empty" }],
    settings: [setting({ key: "stack.roles.chat.enabled", section: { id: "roles", order: 1 } }), setting({ key: "k1" }), setting({ key: "k2", level: "advanced" }), setting({ key: "k3", secret: true, level: "basic" })],
  };
  expect(settingsForScreen(doc, false).map((g) => g.items.map((s) => s.key))).toEqual([["k1", "k3"]]);
  expect(settingsForScreen(doc, true).map((g) => g.items.map((s) => s.key))).toEqual([["k1", "k2", "k3"]]);
});

test("typed numbers are checked against the declared range with a plain sentence", () => {
  const s = setting({});
  expect(coerce(s, "50")).toEqual({ value: 50 });
  expect(coerce(s, "500")).toEqual({ error: "The highest allowed is 100." });
  expect(coerce(s, "0")).toEqual({ error: "The lowest allowed is 1." });
  expect(coerce(s, "ten")).toEqual({ error: "Type a whole number." });
  expect(coerce(s, "")).toEqual({ error: "Type a whole number." });
  expect(coerce(setting({ selector: "text" }), "hello")).toEqual({ value: "hello" });
});

test("a draft beats a pending value beats the value in effect, and pending keys are listed", () => {
  const s = setting({ in_effect: 1, pending: 2 });
  expect(settingValue(s, {})).toBe(2);
  expect(settingValue(s, { [s.key]: 3 })).toBe(3);
  expect(settingValue(setting({ in_effect: 5 }), {})).toBe(5);
  expect(pendingKeys({ sections: [], settings: [s, setting({ key: "b", pending: 1, in_effect: 1 }), setting({ key: "c" })] })).toEqual(["stack.x"]);
  expect(pendingKeys(null)).toEqual([]);
});
