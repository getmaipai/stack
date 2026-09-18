import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const data = mkdtempSync(join(tmpdir(), "maipai-stack-library-"));
const { fetchLibrary, getLibraryPage, listLibrary, searchLibrary, __resetLibraryForTests, __setLibraryModelsForTests, __setLibraryRootForTests, __setLibraryUpdatesForTests } = await import("@/lib/library");
const { handleMcpRequest } = await import("@/mcp/stackLibrary");
__setLibraryRootForTests(join(data, "library"));

beforeEach(() => {
  __resetLibraryForTests();
  __setLibraryUpdatesForTests(true);
  const models = [];
  for (const [id, repo] of [["library-one", "example/one"], ["library-two", "example/two"]] as const) {
    models.push({ id, nickname: null, groupId: null, roles: ["chat" as const], source: "huggingface" as const, provenance: { repo }, revision: "rev-a", sha256: null, sizeBytes: null, licence: "Apache-2.0", engineRequirements: {}, installedAt: null, verifiedAt: null, hostIdentity: null, firstBootAt: "2026-09-18T00:00:00.000Z", modelPath: join(data, `${id}.gguf`), measuredFootprintBytes: null, measuredContextLength: null });
  }
  __setLibraryModelsForTests(models);
});

afterEach(() => { __resetLibraryForTests(); __setLibraryModelsForTests(null); __setLibraryUpdatesForTests(null); });
afterAll(() => rmSync(data, { recursive: true, force: true }));

test("two installed models fetch local pages, search, and rebuild the index", async () => {
  const requests: Request[] = [];
  const result = await fetchLibrary(async (input, init) => {
    requests.push(new Request(String(input), init));
    const repo = new URL(input).pathname.includes("example/one") ? "One" : "Two";
    return new Response(`# ${repo}\n\nA scripted Library page.`, { headers: { etag: `etag-${repo.toLowerCase()}` } });
  });
  expect(result).toEqual({ fetched: 2, skipped: false });
  expect(listLibrary()).toHaveLength(2);
  expect(searchLibrary("scripted").map((item) => item.id)).toEqual(["model-library-one", "model-library-two"]);
  const mcpSearch = handleMcpRequest({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "search", arguments: { q: "# One" } } });
  expect(JSON.stringify(mcpSearch)).toContain("model-library-one");
  expect(getLibraryPage("model-library-one")?.markdown).toContain("# One");
  expect([...requests[0]!.headers.keys()].sort()).toEqual(["if-none-match", "user-agent"]);
  expect(Bun.file(join(data, "library", "index.json")).size).toBeGreaterThan(0);
  expect(Bun.file(join(data, "library", ".pagefind", "pagefind.js")).size).toBeGreaterThan(0);
});

test("the switch prevents outbound fetches and unchanged revisions are not refetched", async () => {
  let calls = 0;
  await fetchLibrary(async () => { calls++; return new Response("# page"); });
  await fetchLibrary(async () => { calls++; return new Response("# should not happen"); });
  expect(calls).toBe(2);
  __setLibraryUpdatesForTests(false);
  const result = await fetchLibrary(async () => { calls++; return new Response("# blocked"); });
  expect(result).toEqual({ fetched: 0, skipped: true });
  expect(calls).toBe(2);
});
