import { expect, test } from "bun:test";
import { changeLine, expandCommand, HELPER_SHORTCUT, helperStateWord, isHelperShortcut, valueWord, waitsText } from "../../admin-ui/src/helperText";

test("state words are plain", () => {
  expect(helperStateWord("notInstalled", false)).toBe("Not installed");
  expect(helperStateWord("installed", false)).toBe("Asleep");
  expect(helperStateWord("installed", true)).toBe("Waking up");
  expect(helperStateWord("ready", false)).toBe("Awake");
  expect(helperStateWord("offline", false)).toBe("Could not start");
});
test("slash commands become questions, /new clears, other text is left alone", () => {
  expect(expandCommand("/health")).toEqual({ send: "Is everything healthy?" });
  expect(expandCommand(" /RESTART ")).toEqual({ send: "Restart the Stack." });
  expect(expandCommand("/new")).toEqual({ clear: true });
  expect(expandCommand("restart please")).toBeNull();
});

test("a confirm card line says what changes, from and to, in plain words", () => {
  expect(valueWord("on")).toBe("On");
  expect(valueWord("100")).toBe("100");
  expect(changeLine({ label: "Video (video clips)", from: "on", to: "off" })).toBe("Video (video clips): On to Off");
  expect(changeLine({ label: "Music priority", from: "100", to: "99" })).toBe("Music priority: 100 to 99");
});

test("a card says how long it waits, and when it has run out", () => {
  const now = Date.parse("2026-11-22T00:00:00Z");
  expect(waitsText("2026-11-22T00:10:00Z", now)).toBe("Waits 10 more minutes.");
  expect(waitsText("2026-11-22T00:00:30Z", now)).toBe("Waits 1 more minute.");
  expect(waitsText("2026-11-21T23:59:00Z", now)).toContain("run out");
});

test("the Helper shortcut is Cmd or Ctrl with slash and nothing else", () => {
  const key = { key: "/", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
  expect(isHelperShortcut(key)).toBe(true);
  expect(isHelperShortcut({ ...key, metaKey: false, ctrlKey: true })).toBe(true);
  expect(isHelperShortcut({ ...key, metaKey: false })).toBe(false);
  expect(isHelperShortcut({ ...key, shiftKey: true })).toBe(false);
  expect(isHelperShortcut({ ...key, key: "k" })).toBe(false);
  expect(HELPER_SHORTCUT.mac).toBe("⌘/");
});
