// The Features, Models, Settings, Updates and Tools screens' pure helpers (admin-ui/src/manage.ts):
// priority order and moves, the reboot switch, model grouping, plain-words wording and setting input checks.
import { expect, test } from "bun:test";
import { byPriority, catalogForRole, coerce, fitWord, installedState, movePriority, pendingKeys, planStateWord, rebootAllowed, settingValue, settingsForScreen } from "../../admin-ui/src/manage";
import type { Setting, SettingsDoc } from "../../admin-ui/src/api";

const setting = (over: Partial<Setting>): Setting => ({
  key: "stack.x", selector: "number", label: "X", help: "", range: { min: 1, max: 100 }, default: 1, section: { id: "a", order: 1 }, level: "basic", needs_restart: false, in_effect: 1, pending: null, ...over,
});

test("priority orders lowest first and keeps arrival order for ties", () => {
  const roles = [{ id: "chat", priority: 100 }, { id: "stt", priority: 10 }, { id: "tts", priority: 100 }];
  expect(byPriority(roles).map((r) => r.id)).toEqual(["stt", "chat", "tts"]);
});

test("moving a role renumbers ties into a real order and writes only the changed keys", () => {
  const equal = [{ id: "chat", priority: 100 }, { id: "judge", priority: 100 }, { id: "tts", priority: 100 }];
  expect(movePriority(equal, "judge", -1)).toEqual({ "stack.roles.judge.priority": 10, "stack.roles.chat.priority": 20, "stack.roles.tts.priority": 30 });
  const ordered = [{ id: "chat", priority: 10 }, { id: "judge", priority: 20 }, { id: "tts", priority: 30 }];
  expect(movePriority(ordered, "judge", 1)).toEqual({ "stack.roles.tts.priority": 20, "stack.roles.judge.priority": 30 });
  expect(movePriority(ordered, "chat", -1)).toEqual({});
  expect(movePriority(ordered, "tts", 1)).toEqual({});
  expect(movePriority(ordered, "nope", 1)).toEqual({});
});

test("reboot is offered only when the declared setting is on", () => {
  const doc = (v: boolean): SettingsDoc => ({ sections: [], settings: [setting({ key: "stack.admin.allow_reboot", selector: "boolean", in_effect: v })] });
  expect(rebootAllowed(doc(true))).toBe(true);
  expect(rebootAllowed(doc(false))).toBe(false);
  expect(rebootAllowed(null)).toBe(false);
});

test("models are grouped by role, installable ones only, and install state reads the stored list", () => {
  const cat = [{ id: "b", role: "chat", download: { url: "u" } }, { id: "a", role: "chat", download: { url: "u" } }, { id: "noUrl", role: "chat" }, { id: "t", role: "tts", download: { url: "u" } }];
  expect(catalogForRole(cat, "chat").map((m) => m.id)).toEqual(["a", "b"]);
  const have = [{ id: "a", roles: ["chat"], state: "installed" as const, runtimeState: "loaded" as const }, { id: "b", roles: ["chat"], state: "installed" as const, fileMissing: true }];
  expect(installedState("a", have)).toBe("loaded");
  expect(installedState("b", have)).toBe("missing");
  expect(installedState("zzz", have)).toBe("missing");
});

test("fit decisions are said in plain words", () => {
  expect(fitWord("refused")).toBe("Does not fit on this computer");
  expect(fitWord("queues")).toContain("tight");
  expect(planStateWord("on_demand")).toBe("Loads when asked");
  expect(planStateWord("off")).toBe("Turned off");
});

test("settings screen hides role switches and secrets, and basic-only unless advanced", () => {
  const doc: SettingsDoc = {
    sections: [{ id: "a", label: "A" }, { id: "roles", label: "Roles" }, { id: "empty", label: "Empty" }],
    settings: [setting({ key: "stack.roles.chat.enabled", section: { id: "roles", order: 1 } }), setting({ key: "k1" }), setting({ key: "k2", level: "advanced" }), setting({ key: "k3", secret: true, level: "basic" })],
  };
  expect(settingsForScreen(doc, false).map((g) => g.items.map((s) => s.key))).toEqual([["k1"]]);
  expect(settingsForScreen(doc, true).map((g) => g.items.map((s) => s.key))).toEqual([["k1", "k2"]]);
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
