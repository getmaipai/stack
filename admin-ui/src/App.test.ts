import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("shell keeps the page fixed and scrolls its main area", () => {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  expect(source).toContain("h-dvh flex-col overflow-hidden");
  expect(source).toContain('id="main-scroll"');
  expect(source).toContain("overflow-y-auto");
});

test("header centers desktop search between the left status and right actions", () => {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const header = source.match(/<header className="([^"]+)"[\s\S]*?<\/header>/)?.[0];
  expect(header).toBeDefined();
  expect(header).toContain("shrink-0");
  expect(header).toContain("flex min-w-0 flex-1 items-center gap-2");
  expect(header).toContain("search-field hidden h-9 w-56");
  expect(header).toContain("flex flex-1 items-center justify-end gap-2");
  expect(header).toContain('className="md:hidden" onClick={() => setPalette(true)}');
});
