import { expect, test } from "bun:test";
import { __setProcessTreeReadersForTests, startTimeOf } from "@/lib/processTree";

test("startTimeOf returns an empty value for a gone pid and reads the live pid", () => {
  __setProcessTreeReadersForTests({ processTable: () => [], commandLine: () => "command", startTime: (pid) => pid === process.pid ? "live-start" : "" });
  expect(startTimeOf(process.pid)).not.toBe("");
  expect(startTimeOf(2_000_000_000)).toBe("");
  __setProcessTreeReadersForTests(null);
});
