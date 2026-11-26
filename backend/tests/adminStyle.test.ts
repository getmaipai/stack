// The admin page's look stays on the kit's tokens and keeps its shared pieces (admin-ui/src/tokens.css, kit.tsx).
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const src = join(import.meta.dir, "../../admin-ui/src");
const read = (name: string) => readFileSync(join(src, name), "utf8");
const files = readdirSync(src).filter((f) => /\.(tsx?|css)$/.test(f));

test("no screen or style paints a raw color: every color is a token", () => {
  for (const f of files) {
    const text = read(f).replace(/\/\*[\s\S]*?\*\//g, "");
    expect({ file: f, raw: text.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) }).toEqual({ file: f, raw: null });
  }
});

test("the shared styles every list, pill and nav item relies on exist", () => {
  const css = read("tokens.css");
  for (const cls of [".eyebrow", ".page-title", ".pill", ".list-row", ".list-row-click", ".empty", ".nav-label", ".nav-item", ".search-field", ".tab-item"]) expect(css).toContain(cls);
  expect(css).toContain("prefers-reduced-motion");
  expect(css).toMatch(/\.list-row-click:focus-visible[^{]*\{[^}]*outline: 2px solid var\(--ring\)/);
});

test("reduced motion shortens every animation and transition, not just the ones that remembered", () => {
  const css = read("tokens.css");
  const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  expect(block).toMatch(/animation-duration: 1ms !important/);
  expect(block).toMatch(/transition-duration: 1ms !important/);
});

test("the sidebar groups every screen once and the palette searches screens, features, models and actions", () => {
  const app = read("App.tsx");
  const order = [...app.matchAll(/order: \[([^\]]*)\]/g)].flatMap((m) => [...m[1]!.matchAll(/"(\w+)"/g)].map((x) => x[1]!));
  const ids = [...app.matchAll(/\{ id: "(\w+)", label: "[^"]+", question:/g)].map((m) => m[1]!);
  expect(ids.length).toBe(11);
  expect([...order].sort()).toEqual([...ids].sort());
  expect(new Set(order).size).toBe(order.length);
  const palette = read("Palette.tsx");
  for (const heading of ["Screens", "Models", "Features", "Actions"]) expect(palette).toContain(`heading="${heading}"`);
});
