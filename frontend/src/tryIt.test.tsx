import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TryItPage } from "@/pages/TryItPage";

afterEach(() => cleanup());

test("Try it shows the ready chat tab and verbatim offline reasons", async () => {
  globalThis.fetch = mock((input: RequestInfo | URL) => { const path = String(input); if (path.endsWith("/roles")) return Promise.resolve(Response.json({ roles: [
    { id: "chat", wire: "chat", residency: "resident", description: "Talk locally.", state: "ready", reason: null },
    { id: "tts", wire: "speech", residency: "resident", description: "Speak locally.", state: "offline", reason: "The voice engine is waiting for its first install." },
    { id: "image", wire: "job", residency: "jit", description: "Make pictures.", state: "notInstalled", reason: null },
  ] })); return Promise.resolve(Response.json({ acknowledged: false })); }) as unknown as typeof fetch;
  render(<MemoryRouter><TryItPage initialRole="tts" /></MemoryRouter>);
  await waitFor(() => expect(document.body.textContent).toContain("Chat"));
  expect(document.body.textContent).toContain("Speak"); expect(document.body.textContent).toContain("Picture");
  expect(document.body.textContent).toContain("The voice engine is waiting for its first install.");
});
