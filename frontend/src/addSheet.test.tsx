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
  fireEvent.change(document.querySelector('input[aria-label="Model path"]')!, { target: { value: "/models/folder.gguf" } });
  fireEvent.click([...document.querySelectorAll("button")].find((button) => button.textContent === "Import path by link")!);
  await waitFor(() => expect(calls.some((call) => call === "POST /stack/v1/models/import")).toBe(true));
});
