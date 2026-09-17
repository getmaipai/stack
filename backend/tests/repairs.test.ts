import { beforeEach, expect, test } from "bun:test";
import { __resetRepairsForTests, listRepairs, raiseRepair } from "@/lib/repairs";

beforeEach(() => __resetRepairsForTests());

test("a second crash within ten minutes upgrades the repair to immediate", () => {
  const first = new Date("2026-09-17T15:00:00.000Z");
  const id = raiseRepair("Chat engine is offline", "first crash", "restart_engine", first);
  raiseRepair("Chat engine is offline", "second crash", "restart_engine", new Date(first.getTime() + 60_000));
  expect(listRepairs()).toEqual([expect.objectContaining({ id, level: "immediate" })]);
});
