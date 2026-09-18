import { afterEach, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { docsLink, DOCS_SITE } from "@/lib/docsLink";
import { HelpPage } from "@/pages/HelpPage";

const docsRoot = join(import.meta.dir, "../../docs/user");
afterEach(cleanup);

test("the shipped knowledge index lists every user guide and renders a guide", () => {
  const index = JSON.parse(readFileSync(join(import.meta.dir, "../public/knowledge/index.json"), "utf8")) as { records: Array<{ title: string; slug: string }> };
  const expected = readdirSync(docsRoot).filter((file) => file.endsWith(".md")).map((file) => readFileSync(join(docsRoot, file), "utf8").match(/^title:\s*(.+)$/m)?.[1] ?? file.replace(/\.md$/, "")).sort();
  expect(index.records.map((record) => record.title).sort()).toEqual(expected);
  expect(readFileSync(join(import.meta.dir, "../public/knowledge/getting-started.html"), "utf8")).toContain("Choose a plan");
});

test("the Help page lists the shipped guides and renders the selected guide", async () => {
  const index = readFileSync(join(import.meta.dir, "../public/knowledge/index.json"), "utf8");
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/knowledge/index.json") return new Response(index, { headers: { "content-type": "application/json" } });
    if (path === "/knowledge/getting-started.html") return new Response("<h2>Choose a plan</h2><p>Local guide</p>");
    return Response.json({ app: { checksEnabled: false } });
  }) as unknown as typeof fetch;
  render(<MemoryRouter initialEntries={["/help/getting-started"]}><Routes><Route path="/help/:page" element={<HelpPage Frame={({ children }) => <main>{children}</main>} />} /></Routes></MemoryRouter>);
  await waitFor(() => expect(document.body.textContent).toContain("Choose a plan"));
  const expectedCount = readdirSync(docsRoot).filter((file) => file.endsWith(".md")).length;
  expect(document.querySelectorAll('nav[aria-label="Help pages"] a').length).toBe(expectedCount);
});

test("docsLink keeps Help local until outbound checks are enabled", () => {
  expect(docsLink("fix-a-problem", "choose-a-guide")).toBe("/help/fix-a-problem#choose-a-guide");
  expect(docsLink("fix-a-problem", "choose-a-guide", true)).toBe(`${DOCS_SITE}/fix-a-problem/#choose-a-guide`);
});
