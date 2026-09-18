import { expect, test } from "bun:test";
import { lifecycleAction } from "./lifecycle";

test.each([
  ["running", "attach"], ["agent", "start"], ["missing", "install"],
] as const)("daemon lifecycle: %s -> %s", (state, action) => {
  expect(lifecycleAction(state)).toBe(action);
});
