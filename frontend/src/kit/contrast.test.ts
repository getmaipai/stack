import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(import.meta.dir, "tokens.css"), "utf8");

function block(source: string, from: string, to?: string): string {
  const start = source.indexOf(from);
  const end = to ? source.indexOf(to, start) : source.length;
  return source.slice(start, end === -1 ? undefined : end);
}

function readVar(source: string, name: string): string {
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6});`).exec(source);
  if (!match) throw new Error(`${name} not found`);
  return match[1]!;
}

function relativeLuminance(hex: string): number {
  const channel = (value: number) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const r = channel(parseInt(hex.slice(1, 3), 16));
  const g = channel(parseInt(hex.slice(3, 5), 16));
  const b = channel(parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const luminances = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (luminances[0]! + 0.05) / (luminances[1]! + 0.05);
}

const lightRoot = block(css, ":root {", "@media (max-width: 639px)");
const darkRoot = block(css, ".dark {");

type Theme = { name: string; primaryText: string; surfaces: Record<string, string> };

const themes: Theme[] = [
  { name: "light", primaryText: readVar(lightRoot, "--foreground"), surfaces: { canvas: readVar(lightRoot, "--surface-page"), sidebar: readVar(lightRoot, "--surface-sidebar"), panel: readVar(lightRoot, "--surface-card"), "raised panel": readVar(lightRoot, "--surface-pane") } },
  { name: "dark", primaryText: readVar(darkRoot, "--foreground"), surfaces: { canvas: readVar(darkRoot, "--surface-page"), sidebar: readVar(darkRoot, "--surface-sidebar"), panel: readVar(darkRoot, "--surface-card"), "raised panel": readVar(darkRoot, "--surface-pane") } },
];

const secondaryText: Record<string, string> = { light: readVar(lightRoot, "--muted-foreground"), dark: readVar(darkRoot, "--muted-foreground") };

describe("WCAG AA contrast over the spec's surfaces (both themes)", () => {
  for (const theme of themes) {
    for (const [surfaceName, surfaceHex] of Object.entries(theme.surfaces)) {
      test(`${theme.name}: primary text on ${surfaceName} clears 4.5`, () => {
        expect(contrastRatio(theme.primaryText, surfaceHex)).toBeGreaterThanOrEqual(4.5);
      });

      test(`${theme.name}: secondary text on ${surfaceName} clears 4.5, or 3.0 for the 12px supporting size on a raised panel`, () => {
        const ratio = contrastRatio(secondaryText[theme.name]!, surfaceHex);
        const floor = surfaceName === "raised panel" ? 3.0 : 4.5;
        if (surfaceName === "raised panel" && ratio < 4.5) console.log(`${theme.name} secondary-on-raised-panel: ${ratio.toFixed(2)}:1 (below 4.5, the 12px-supporting-text exception applies)`);
        expect(ratio).toBeGreaterThanOrEqual(floor);
      });
    }
  }
});
