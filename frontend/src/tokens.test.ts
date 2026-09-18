import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const tokensPath = resolve(import.meta.dir, "kit/tokens.css");
const cardPath = resolve(import.meta.dir, "kit/ui/card.tsx");

describe("dark theme tokens", () => {
  test("background is true black", () => {
    const css = readFileSync(tokensPath, "utf8");
    expect(css).toContain("--background: hsl(0 0% 0%);");
  });
});

describe("card has no shadow", () => {
  test("card.tsx contains no shadow-", () => {
    const src = readFileSync(cardPath, "utf8");
    expect(src).not.toContain("shadow-");
  });
});
