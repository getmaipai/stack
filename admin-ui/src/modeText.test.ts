import { expect, test } from "bun:test";
import { failureText, modeBusy, modeHeadline, roleWord } from "./modeText";
import type { ModeView } from "./modeText";
const base: ModeView = { mode: "normal", target: "normal", state: "stable", reason: null, available: true, checks: { engine: true, pieces: true, hardware: true, memory: true, bench: true }, self_test: { passed_at: null, stale: false }, memory: { plan_bytes: 1, budget_bytes: 2 } };
test("a failed switch says what failed in plain words and that the mode stayed", () => {
  const v: ModeView = { ...base, target: "coding", state: "failed", reason: "The large coding model did not complete its thinking check." };
  expect(failureText(v)).toContain("thinking check");
  expect(modeHeadline(v)).toContain("still in Normal");
  expect(modeBusy(v)).toBe(false);
});
test("a running switch is busy and a stable one says its mode", () => {
  expect(modeBusy({ ...base, target: "coding", state: "switching" })).toBe(true);
  expect(modeHeadline(base)).toBe("Normal mode is on.");
  expect(roleWord("ready")).toBe("On and ready");
});
