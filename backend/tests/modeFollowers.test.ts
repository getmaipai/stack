// The roles that follow Home's mode (chat, judge, router) come from the
// `followsHomeMode` flag on the role table, exported as MODE_FOLLOWER_ROLES.
// No consumer may repeat the literal list.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MODE_FOLLOWER_ROLES } from "@/roles";

test("MODE_FOLLOWER_ROLES is exactly chat, judge, router in order", () => {
  expect(MODE_FOLLOWER_ROLES).toEqual(["chat", "judge", "router"]);
});

for (const rel of ["src/lib/supervisor.ts", "src/lib/router.ts", "src/lib/homeModeRuntime.ts"]) {
  test(`${rel} does not repeat the follower role literal`, () => {
    const source = readFileSync(join(import.meta.dir, "..", rel), "utf8");
    // The three-follower list, brackets included; the four-role list that
    // adds "coding" during a mode switch is a different literal.
    expect(source.includes('["chat", "judge", "router"]')).toBe(false);
  });
}
