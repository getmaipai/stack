// ROLE-UNITS-01: the six ordinary role units (chat, judge, coding, vision,
// embed, stt) take their group, serves and usedBy text from rows/roleUnits.json.
// The expected tuples below are copied from the if/else chain the rows replaced,
// so the units cannot drift. The last check pins the source shape: components.ts
// no longer names the chat role in code.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, mock, test } from "bun:test";

/** [role, group, serves, usedBy text] exactly as the old chain had them. */
const EXPECTED: Array<[string, string, string, string[]]> = [
  ["chat", "chat", "chat", ["Chat"]],
  ["judge", "chat", "judge", ["Quick checks"]],
  ["coding", "chat", "coding", ["Coding"]],
  ["vision", "chat", "vision", ["Describing pictures"]],
  ["embed", "chat", "embed", ["Memory and search"]],
  ["stt", "voice", "stt", ["Listening"]],
];

// selectedModel decides whether a unit's usedBy() text shows; answer with the
// unit's own primary id so the text is observable without installing models.
const actualSupervisor = await import("@/lib/supervisor");
const selectedIds = new Map<string, string>();
mock.module("@/lib/supervisor", () => ({
  ...actualSupervisor,
  selectedModel: (role: string) => (selectedIds.has(role) ? { id: selectedIds.get(role)! } : null),
}));
const { componentDefs } = await import("@/lib/components");

test("the six role units keep the group, serves and usedBy text of the old chain", () => {
  const units = componentDefs();
  for (const [role, group, serves, usedByText] of EXPECTED) {
    const matching = units.filter((unit) => unit.role === role);
    expect(matching.length > 0).toBe(true);
    for (const unit of matching) {
      expect<string>(unit.group).toBe(group);
      expect(unit.serves).toBe(serves);
      // Nothing selected for the role: no text. The unit's own pin selected: the exact text.
      selectedIds.delete(serves);
      expect(unit.usedBy()).toEqual([]);
      selectedIds.set(serves, unit.id);
      expect(unit.usedBy()).toEqual(usedByText);
    }
  }
  selectedIds.clear();
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
