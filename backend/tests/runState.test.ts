import { afterEach, expect, test } from "bun:test";
import { admit, getRunState, pauseAll, __resetGovernorForTests, resumeAll } from "@/lib/governor";

afterEach(() => { __resetGovernorForTests(); resumeAll(); });

test("pauseAll refuses new admissions and resume reopens them", async () => {
  await pauseAll();
  expect(getRunState()).toBe("paused");
  expect(await admit({ id: "chat", kind: "resident", requestedBytes: 1 })).toEqual({ refused: true, reason: "The Stack is paused." });
  resumeAll();
  expect(getRunState()).toBe("running");
});
