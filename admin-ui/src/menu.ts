import screensSpec from "@maipai/spec/stack/screens.json";
import areasSpec from "@maipai/spec/settings/areas.json";

/**
 * The Stack admin menu, built from the shared spec so it cannot drift from Home's Stack page:
 * the groups are the tabs of the Stack section in `spec/settings/areas.json` (General, Models, Styles, Monitor, Maintain),
 * and each screen sits under the group named by its `tab` in `spec/stack/screens.json`.
 * A group with no screens (General is Home's own tab) is not drawn.
 */
export interface MenuScreen { id: string; label: string; question: string; tab: string }
export interface MenuGroup { id: string; label: string; screens: MenuScreen[] }

/** The screens this admin page draws itself. */
export const IMPLEMENTED: readonly string[] = ["overview", "health", "resources", "models", "styles", "modes", "engines", "updates", "settings", "tools", "helper", "connections"];
/** Spec screens with no screen of their own here yet: where an old address goes (their content sits inside AI and models), or null for none. */
export const NOT_YET: Readonly<Record<string, string | null>> = { drives: "models", licences: "models" };

interface SpecScreen { id: string; label: string; question: string; tab: string }
interface SpecTab { id: string; label: string }
export const SPEC_SCREENS = (screensSpec as unknown as { screens: SpecScreen[] }).screens;
export const SPEC_TABS: SpecTab[] = (areasSpec as unknown as { areas: { sections: { id: string; tabs?: SpecTab[] }[] }[] }).areas
  .flatMap((a) => a.sections).find((s) => s.id === "stack")?.tabs ?? [];

export function buildMenu(screens: readonly SpecScreen[], tabs: readonly SpecTab[]): MenuGroup[] {
  return tabs
    .map((t) => ({ id: t.id, label: t.label, screens: screens.filter((s) => s.tab === t.id && IMPLEMENTED.includes(s.id)).map(({ id, label, question, tab }) => ({ id, label, question, tab })) }))
    .filter((g) => g.screens.length > 0);
}

export const MENU: MenuGroup[] = buildMenu(SPEC_SCREENS, SPEC_TABS);
export const MENU_SCREENS: MenuScreen[] = MENU.flatMap((g) => g.screens);
