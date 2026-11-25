import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("shell keeps the page fixed and scrolls its main area", () => {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  expect(source).toContain("h-dvh flex-col overflow-hidden");
  expect(source).toContain('id="main-scroll"');
  expect(source).toContain("overflow-y-auto");
});
