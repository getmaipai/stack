import { afterEach, expect, mock, test } from "bun:test";
import { installFromCatalog, resolveHuggingFace, searchCatalog, searchHuggingFace, type CatalogEntry } from "@/lib/catalogSearch";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const entry: CatalogEntry = { id: "qwen3-27b", name: "Qwen3 27B", kind: "model", roles: ["chat"], licence: "Apache-2.0", sizeBytes: 100, source: "catalog", revision: "1", url: "https://example.com/model.gguf", sha256: "a".repeat(64), repo: "qwen/qwen3-27b" };

test("searchCatalog hits the catalog route with kind and query, empty on a bad response", async () => {
  let requested = "";
  globalThis.fetch = mock(async (input: RequestInfo | URL) => { requested = String(input); return new Response(JSON.stringify({ results: [entry] }), { status: 200 }); }) as unknown as typeof fetch;
  const results = await searchCatalog("model", "qwen");
  expect(requested).toBe("/stack/v1/catalog/search?kind=model&q=qwen");
  expect(results).toEqual([entry]);

  globalThis.fetch = mock(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
  expect(await searchCatalog("model", "qwen")).toEqual([]);
});

test("searchHuggingFace skips the request for an empty query and leaves `enabled` unset", async () => {
  // Regression: an earlier version defaulted to `enabled: true` here, so a
  // caller that unconditionally applied it (AddSheet's searchHub) would
  // flip a real "Hugging Face search is off" state back to "on" the
  // moment the search box was cleared and searched again.
  globalThis.fetch = mock(async () => { throw new Error("should not fetch"); }) as unknown as typeof fetch;
  expect(await searchHuggingFace("  ")).toEqual({ results: [] });
});

test("resolveHuggingFace returns null on a failed response", async () => {
  globalThis.fetch = mock(async () => new Response("", { status: 404 })) as unknown as typeof fetch;
  expect(await resolveHuggingFace("qwen/qwen3-27b")).toBeNull();
});

test("installFromCatalog posts the model to /stack/v1/models", async () => {
  let body: unknown;
  globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
  await installFromCatalog(entry, "catalog");
  expect(body).toEqual({ id: "qwen3-27b", source: "catalog", roles: ["chat"], url: entry.url, sha256: entry.sha256, licence: entry.licence, revision: entry.revision });
});
