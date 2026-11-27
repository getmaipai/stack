import { describe, expect, test } from "bun:test";
import { IMPLEMENTED, MENU, MENU_SCREENS, NOT_YET, SPEC_SCREENS, SPEC_TABS } from "./menu";

describe("the admin menu matches spec/stack/screens.json", () => {
  test("every spec screen is drawn here or named in NOT_YET, and nothing else is drawn", () => {
    const specIds = SPEC_SCREENS.map((s) => s.id).sort();
    const known = [...IMPLEMENTED, ...Object.keys(NOT_YET)].sort();
    expect(known).toEqual(specIds);
  });
  test("each screen is under the group named by its tab, with the spec's label and question, in spec order", () => {
    for (const g of MENU) {
      const expected = SPEC_SCREENS.filter((s) => s.tab === g.id && IMPLEMENTED.includes(s.id));
      expect(g.screens.map((s) => [s.id, s.label, s.question, s.tab])).toEqual(expected.map((s) => [s.id, s.label, s.question, s.tab]));
    }
    expect(MENU_SCREENS.length).toBe(IMPLEMENTED.length);
  });
  test("the groups are the Stack tabs of Home's settings, in order, minus tabs with no screen", () => {
    const withScreens = SPEC_TABS.filter((t) => SPEC_SCREENS.some((s) => s.tab === t.id && IMPLEMENTED.includes(s.id)));
    expect(MENU.map((g) => [g.id, g.label])).toEqual(withScreens.map((t) => [t.id, t.label]));
    expect(SPEC_TABS.map((t) => t.label)).toEqual(["General", "Models", "Styles", "Monitor", "Maintain"]);
  });
  test("every old address that points at another screen lands on a real one", () => {
    for (const target of Object.values(NOT_YET)) if (target) expect(IMPLEMENTED).toContain(target);
  });
});
