import { expect, test } from "bun:test";
import { expandCommand, helperStateWord } from "../../admin-ui/src/helperText";

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
