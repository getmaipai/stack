import { afterEach, expect, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AddSheet } from "@/kit/blocks/add-sheet/AddSheet";

afterEach(() => { document.body.innerHTML = ""; });

test("the Hugging Face sheet withholds Install until a chosen repository is resolved", async () => {
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("huggingface/resolve")) return new Response(JSON.stringify({ result: { id: "chat/repo", name: "chat/repo", kind: "model", roles: ["unknown"], licence: "Apache-2.0", sizeBytes: null, source: "Hugging Face", revision: "a".repeat(40), url: "https://hf.test/chat/repo", sha256: null, repo: "chat/repo", files: [] } }));
    if (url.includes("kind=huggingface")) return new Response(JSON.stringify({ enabled: true, results: [{ id: "chat/repo", name: "chat/repo", kind: "model", licence: null, sizeBytes: null, source: "Hugging Face", revision: null, url: null, sha256: null, repo: "chat/repo", files: [] }] }));
    return new Response(JSON.stringify({ results: [], candidates: [] }));
  }) as typeof fetch;
  render(<AddSheet kind="model" open onOpenChange={() => {}} />);
  const hubTab = screen.getByRole("tab", { name: "Hugging Face" });
  fireEvent.mouseDown(hubTab);
  fireEvent.click(hubTab);
  const search = await screen.findByLabelText("Search Hugging Face");
  fireEvent.change(search, { target: { value: "chat" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByRole("button", { name: "Choose" });
  fireEvent.click(screen.getByRole("button", { name: "Choose" }));
  await waitFor(() => expect(screen.getByText("This repository has unknown ability, so Install is unavailable.")).toBeTruthy());
  expect((screen.getByRole("button", { name: "Install" }) as HTMLButtonElement).disabled).toBe(true);
});
