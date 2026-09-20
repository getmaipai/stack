import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

test("the Catalog's signed engine index names the newest build for this machine against the current link; the same build installed means nothing available; an expired index says unknown", async () => {
  updateSettings({ "stack.updates.enabled": true });
  mkdirSync(engineTagRoot("llama-server", "b1"), { recursive: true });
  writeFileSync(join(engineTagRoot("llama-server", "b1"), ".engine-ready"), "now");
  await swapEngine("llama-server", "b1");
  const entry = (tag: string, notes: string) => ({ name: "llama-server", tag, platform: process.platform, arch: process.arch, url: `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/x.tar.gz`, sha256: "c".repeat(64), size: 5, licence: "MIT", notes });
  const envelope = (engines: unknown[], expires = new Date(Date.now() + 86_400_000).toISOString()) => ({ signed: { type: "engine-index", version: "2026-09-20", expires, published: 1, engines }, signatures: [{ keyid: "k", sig: "s" }] });
  const state = await checkCatalog(async (input) => String(input) === ENGINE_INDEX_URL ? respond(envelope([entry("b2", "faster"), entry("b3", "fastest"), entry("b1", "installed")])) : respond({ version: "1", models: [] }));
  expect(state.engines[0]).toMatchObject({ installed: "b1", available: "b3", availableKnown: true, notes: "fastest" });
  expect(engineCurrentPath("llama-server")).toContain("current");
  __resetUpdatesForTests();
  const same = await checkCatalog(async (input) => String(input) === ENGINE_INDEX_URL ? respond(envelope([entry("b1", "installed")])) : respond({ version: "1", models: [] }));
  expect(same.engines[0]).toMatchObject({ installed: "b1", available: null, availableKnown: true });
  __resetUpdatesForTests();
  const expired = await checkCatalog(async (input) => String(input) === ENGINE_INDEX_URL ? respond(envelope([entry("b3", "x")], new Date(Date.now() - 1000).toISOString())) : respond({ version: "1", models: [] }));
  expect(expired.engines[0]).toMatchObject({ available: null, availableKnown: false });
  __resetUpdatesForTests();
  // A build this machine cannot run (NVIDIA required, none here) is never offered; a runnable one carries its extras into staging.
  const cuda = { ...entry("b4", "cuda"), requires: ["nvidia"], extra: [{ url: "https://github.com/x/cudart.zip", sha256: "d".repeat(64), size: 3, label: "cudart" }] };
  const { stagingPin } = await import("@/updates/engines");
  const offered = await checkCatalog(async (input) => String(input) === ENGINE_INDEX_URL ? respond(envelope([cuda, entry("b2", "plain")])) : respond({ version: "1", models: [] }));
  expect(offered.engines[0]!.available).toBe(process.platform === "win32" ? "b2" : "b2");
  const staged = stagingPin("llama-server", cuda.tag, cuda);
  expect(staged.requiresNvidia).toBe(true);
  expect(staged.extraArchives).toEqual([{ label: "cudart", url: "https://github.com/x/cudart.zip", sha256: "d".repeat(64), approxBytes: 3 }]);
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
