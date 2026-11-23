// ROLE-UNITS-01: the six ordinary role units (chat, judge, coding, vision,
// embed, stt) take their group, serves and usedBy text from rows/roleUnits.json.
// The expected tuples below are copied from the if/else chain the rows replaced,
// so the units cannot drift. The last check pins the source shape: components.ts
// no longer names the chat role in code.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

/** [role, group, serves, usedBy text] exactly as the old chain had them. */
const EXPECTED: Array<[string, string, string, string[]]> = [
  ["chat", "chat", "chat", ["Chat"]],
  ["judge", "chat", "judge", ["Quick checks"]],
  ["coding", "chat", "coding", ["Coding"]],
  ["vision", "chat", "vision", ["Describing pictures"]],
  ["embed", "chat", "embed", ["Memory and search"]],
  ["stt", "voice", "stt", ["Listening"]],
];

const { componentDefs } = await import("@/lib/components");
const roleRows = (await import("@/rows/roleUnits.json")).default as Array<{ role: string; usedBy: string[] }>;

test("the six role units keep the group and serves of the old chain, and the rows hold the usedBy text", () => {
  const units = componentDefs();
  for (const [role, group, serves, usedByText] of EXPECTED) {
    const matching = units.filter((unit) => unit.role === role);
    expect(matching.length > 0).toBe(true);
    for (const unit of matching) {
      expect<string>(unit.group).toBe(group);
      expect(unit.serves).toBe(serves);
    }
    expect(roleRows.find((row) => row.role === role)?.usedBy).toEqual(usedByText);
  }
});

test("componentDefs keeps the units in catalog order with the tts unit after stt", () => {
  const roles = componentDefs().map((unit) => unit.role);
  const first = <T,>(items: T[], predicate: (item: T) => boolean): number => items.findIndex(predicate);
  const at = (role: string): number => first(roles, (unitRole) => unitRole === role);
  expect(at("chat")).toBeLessThan(at("tts"));
  expect(at("stt")).toBeLessThan(at("tts"));
});

test("components.ts no longer names the chat role in code", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src", "lib", "components.ts"), "utf8");
  expect(source.includes('pin.role === "chat"')).toBe(false);
});

