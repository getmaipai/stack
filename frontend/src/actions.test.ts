import { expect, test } from "bun:test";
import { actionsFor } from "@/lib/actions";

test("each thing kind has one declared row action list", () => {
  const kinds = ["engine", "model", "detected", "group", "client"] as const;
  for (const kind of kinds) {
    const labels = actionsFor(kind, { loaded: false, current: false, notCurrent: true, newestTag: "next", count: 2 }, () => {}, "row").map((action) => action.label);
    expect(labels.length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(labels.length);
  }
  expect(actionsFor("model", { loaded: true }, () => {}, "row").map((action) => action.label)).toEqual(["Unload", "Pin", "Rename", "Move to group", "Update", "Remove"]);
  expect(actionsFor("detected", {}, () => {}, "row").map((action) => action.label)).toEqual(["Adopt", "Forget"]);
});
