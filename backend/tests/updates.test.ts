import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { app } from "@/app";
import { __resetEventsForTests, eventsAfter } from "@/lib/events";
import { clearModelsForTests, upsertModel } from "@/lib/modelStore";
import { engineCurrentPath, engineTagRoot } from "@/lib/store/layout";
import { __resetSettingsForTests, updateSettings } from "@/settings";
import { __resetUpdatesForTests, checkCatalog, recommendationsFor, updatesState, MODEL_INDEX_URL, ENGINE_INDEX_URL } from "@/updates/catalog";
import { swapEngine } from "@/updates/engines";

const modelIndex = { version: "1", models: [{ id: "qwen3-1.7b-q8-0", role: "chat", profile: "p16", quality: 2, revision: "newer-revision", download: { url: "https://huggingface.co/x/resolve/newer-revision/m.gguf", sha256: "b".repeat(64), approx_bytes: 10 } }] };
function respond(body: unknown, status = 200): Response { return new Response(status === 304 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", etag: '"e1"' } }); }

beforeEach(() => { __resetUpdatesForTests(); __resetSettingsForTests(); __resetEventsForTests(); clearModelsForTests(); });
afterEach(() => { clearModelsForTests(); rmSync(engineTagRoot("llama-server", "b1").replace(/\/b1$/, ""), { recursive: true, force: true }); });

test("with update checks off, nothing is fetched and the state says so", async () => {
  let calls = 0;
  const state = await checkCatalog(async () => { calls++; return respond({}); });
  expect(calls).toBe(0);
  expect(state.checksEnabled).toBe(false);
  expect(state.engines[0]).toMatchObject({ name: "llama-server", availableKnown: false, available: null, lastChecked: null });
});

test("installed, available, last checked: a newer model revision in the index is announced once; engines report unknown until the Catalog publishes their index", async () => {
  updateSettings({ "stack.updates.enabled": true });
  upsertModel({ id: "qwen3-1.7b-q8-0", roles: ["chat"], source: "catalog", provenance: {}, revision: "old-revision", sha256: "a".repeat(64), licence: "Apache-2.0" });
  const fetcher = async (input: string | URL | Request) => String(input) === MODEL_INDEX_URL ? respond(modelIndex) : String(input) === ENGINE_INDEX_URL ? respond({ error: "not found" }, 404) : respond({}, 500);
  const state = await checkCatalog(fetcher);
  expect(state.models.entries[0]).toMatchObject({ id: "qwen3-1.7b-q8-0", installed: "old-revision", available: "newer-revision" });
  expect(state.models.lastChecked).not.toBeNull();
  expect(state.engines[0]).toMatchObject({ availableKnown: false, available: null });
  expect(state.engines[0]!.lastChecked).not.toBeNull();
  expect(eventsAfter(0).filter((event) => event.id === "update.available")).toHaveLength(1);
  await checkCatalog(fetcher);
  expect(eventsAfter(0).filter((event) => event.id === "update.available")).toHaveLength(1);
});

test("an engine index names the available build against the current link", async () => {
  updateSettings({ "stack.updates.enabled": true });
  mkdirSync(engineTagRoot("llama-server", "b1"), { recursive: true });
  await swapEngine("llama-server", "b1");
  const index = { version: "1", engines: [{ name: "llama-server", tag: "b2", platform: process.platform, arch: process.arch, url: "https://github.com/ggml-org/llama.cpp/releases/download/b2/x.tar.gz", sha256: "c".repeat(64), size: 5, notes: "faster" }] };
  const state = await checkCatalog(async (input) => String(input) === ENGINE_INDEX_URL ? respond(index) : respond({ version: "1", models: [] }));
  expect(state.engines[0]).toMatchObject({ installed: "b1", available: "b2", availableKnown: true, notes: "faster" });
  expect(engineCurrentPath("llama-server")).toContain("current");
});

test("the request is a conditional GET with the Stack user agent and no identifier", async () => {
  updateSettings({ "stack.updates.enabled": true });
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  await checkCatalog(async (input, init) => { seen.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> }); return respond({}, 404); });
  expect(seen[0]!.url).toBe(MODEL_INDEX_URL);
  expect(seen[0]!.url).not.toContain("?");
  expect(seen[0]!.headers["user-agent"]).toMatch(/^maipai-stack\/\d+\.\d+\.\d+ \(/);
  expect(Object.keys(seen[0]!.headers).sort()).toEqual(["if-none-match", "user-agent"]);
});

test("an invalid index leaves available unknown instead of a guess", async () => {
  updateSettings({ "stack.updates.enabled": true });
  await expect(checkCatalog(async () => respond({ version: "1", models: [{ id: "x" }] }))).rejects.toThrow();
  expect(updatesState().models.lastChecked).toBeNull();
  const response = await app.request("/stack/v1/updates");
  expect((await response.json() as { engines: Array<{ availableKnown: boolean }> }).engines[0]!.availableKnown).toBe(false);
});

test("recommendations fit the profile and add a role or improve a band, never install", () => {
  const index = { version: "1", models: [
    { id: "a", role: "chat", profile: "p16" as const, quality: 2, revision: "r", download: { url: "https://huggingface.co/a", sha256: "a".repeat(64), approx_bytes: 1 } },
    { id: "b", role: "image", profile: "p128" as const, quality: 1, revision: "r", download: { url: "https://huggingface.co/b", sha256: "a".repeat(64), approx_bytes: 1 } },
  ] };
  expect(recommendationsFor(index, "p32", { chat: 1 }).map((entry) => entry.id)).toEqual(["a"]);
  expect(recommendationsFor(index, "p32", { chat: 2 })).toEqual([]);
  expect(recommendationsFor(index, null)).toEqual([]);
});
