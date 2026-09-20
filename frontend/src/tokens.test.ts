import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const tokensPath = resolve(import.meta.dir, "kit/tokens.css");
const cardPath = resolve(import.meta.dir, "kit/ui/card.tsx");

const DARK_VALUES: Record<string, string> = {
  "--surface-page": "#07111f",
  "--surface-sidebar": "#0a1a2e",
  "--surface-card": "#102238",
  "--surface-pane": "#142a43",
  "--border": "#294563",
  "--foreground": "#f4f8ff",
  "--muted-foreground": "#a9bed7",
  "--primary": "#21a6ff",
};

const HUES: Record<string, string> = {
  "--hue-violet": "#a434ff",
  "--hue-teal": "#00e3ae",
  "--hue-orange": "#ff8a35",
  "--hue-pink": "#ff3e9a",
  "--hue-red": "#ff4b62",
};

describe("dark theme tokens (spec section 1, the reference theme)", () => {
  const css = readFileSync(tokensPath, "utf8");
  const darkBlock = css.slice(css.indexOf(".dark {"));

  test("the 8 surface/text/accent values from the spec are on the .dark root", () => {
    for (const [name, value] of Object.entries(DARK_VALUES)) expect(darkBlock).toContain(`${name}: ${value};`);
  });

  test("the 5 named hues from the spec are declared once, theme-invariant", () => {
    for (const [name, value] of Object.entries(HUES)) expect(css).toContain(`${name}: ${value};`);
  });

  test("the system-preference default matches the explicit .dark class", () => {
    const mediaBlock = css.slice(css.indexOf("prefers-color-scheme: dark"), css.indexOf(".dark {"));
    for (const [name, value] of Object.entries(DARK_VALUES)) expect(mediaBlock).toContain(`${name}: ${value};`);
  });
});

describe("card has no shadow", () => {
  test("card.tsx contains no shadow-", () => {
    const src = readFileSync(cardPath, "utf8");
    expect(src).not.toContain("shadow-");
  });
});
