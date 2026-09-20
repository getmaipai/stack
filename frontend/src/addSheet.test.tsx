import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { AddSheet } from "@/kit/blocks/add-sheet/AddSheet";

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

test("Add sheet installs a catalog model and imports a scripted folder", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path.includes("catalog/search")) return Promise.resolve(Response.json({ enabled: true, results: [{ id: "qwen3-1.7b-q8-0", name: "qwen3-1.7b-q8-0", kind: "model", roles: ["chat"], licence: "Apache-2.0", sizeBytes: 100, source: "MaiPai Catalog", revision: "main", url: "https://example.test/model.gguf", sha256: "a", repo: "Qwen/Qwen3" }] }));
    if (path.endsWith("/models/import")) return Promise.resolve(Response.json({ candidates: [] }));
    return Promise.resolve(Response.json({ ok: true }));
  }) as unknown as typeof fetch;
  render(<AddSheet kind="model" open onOpenChange={() => {}} />);
  await waitFor(() => expect(document.body.textContent).toContain("Qwen3 1.7B"));
  fireEvent.click([...document.querySelectorAll("button")].find((button) => button.textContent === "Install")!);
  await waitFor(() => expect(calls.some((call) => call === "POST /stack/v1/models")).toBe(true));
  const importTab = [...document.querySelectorAll('button[role="tab"]')].find((button) => button.textContent === "Import")!;
  fireEvent.mouseDown(importTab);
  fireEvent.click(importTab);
  await waitFor(() => expect(document.querySelector('input[aria-label="Model path"]')).toBeTruthy());
  expect(document.body.textContent).toContain("Scan this computer");
  fireEvent.change(document.querySelector('input[aria-label="Model path"]')!, { target: { value: "/models/folder.gguf" } });
  fireEvent.click([...document.querySelectorAll("button")].find((button) => button.textContent === "Import path by link")!);
  await waitFor(() => expect(calls.some((call) => call === "POST /stack/v1/models/import")).toBe(true));
});

test("clearing the Hugging Face search box and searching again keeps the disabled banner", async () => {
  // Regression: searchHuggingFace used to default a skipped (empty-query)
  // request to `enabled: true`, so re-searching with an empty box after
  // a real "disabled" response flipped the banner off again.
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes("kind=huggingface")) return Promise.resolve(Response.json({ enabled: false, results: [] }));
    if (path.includes("catalog/search")) return Promise.resolve(Response.json({ enabled: true, results: [] }));
    if (path.endsWith("/models/import")) return Promise.resolve(Response.json({ candidates: [] }));
    return Promise.resolve(Response.json({ ok: true }));
  }) as unknown as typeof fetch;
  render(<AddSheet kind="model" open onOpenChange={() => {}} />);
  const hfTab = await waitFor(() => { const button = [...document.querySelectorAll('button[role="tab"]')].find((candidate) => candidate.textContent === "Hugging Face"); expect(button).toBeTruthy(); return button!; });
  fireEvent.mouseDown(hfTab);
  fireEvent.click(hfTab);
  const searchInput = await waitFor(() => { const input = document.querySelector<HTMLInputElement>('input[aria-label="Search Hugging Face"]'); expect(input).toBeTruthy(); return input!; });
  fireEvent.change(searchInput, { target: { value: "qwen" } });
  fireEvent.click([...document.querySelectorAll("button")].find((button) => button.textContent === "Search")!);
  await waitFor(() => expect(document.body.textContent).toContain("Hugging Face search is off"));

  fireEvent.change(searchInput, { target: { value: "" } });
  fireEvent.click([...document.querySelectorAll("button")].find((button) => button.textContent === "Search")!);
  await waitFor(() => expect(document.body.textContent).toContain("Hugging Face search is off"));
});
