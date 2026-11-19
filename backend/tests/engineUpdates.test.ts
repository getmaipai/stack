import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/app";
import { __resetEngineUpdatesForTests, checkEngineUpdates, ENGINE_UPDATE_CHECK_INTERVAL_MS, engineUpdateFor } from "@/lib/engineUpdates";
import { engineTagRoot } from "@/lib/store/layout";
import { __resetSettingsForTests, updateSettings } from "@/settings";
import { swapEngine } from "@/updates/engines";

const release = (tag: string) => new Response(JSON.stringify([{ tag_name: "v1.0.0" }, { tag_name: tag }]), { status: 200, headers: { "content-type": "application/json" } });
const installBuild = async (tag: string) => {
  mkdirSync(engineTagRoot("llama-server", tag), { recursive: true });
  writeFileSync(join(engineTagRoot("llama-server", tag), ".engine-ready"), "now");
  await swapEngine("llama-server", tag, { emitEvents: false });
};
const t0 = new Date("2026-11-01T10:00:00.000Z");
const later = (ms: number) => new Date(t0.getTime() + ms);

beforeEach(async () => { __resetEngineUpdatesForTests(); __resetSettingsForTests(); updateSettings({ "stack.updates.enabled": true }); await installBuild("b1"); });
afterEach(() => { __resetEngineUpdatesForTests(); rmSync(engineTagRoot("llama-server", "b1").replace(/\/b1$/, ""), { recursive: true, force: true }); });

test("a newer release creates one record with the day it was first noticed, and a second check keeps that day", async () => {
  const urls: string[] = [];
  await checkEngineUpdates({ fetcher: async (url) => { urls.push(String(url)); return release("b5"); }, now: t0 });
  expect(urls).toEqual(["https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=30"]);
  expect(engineUpdateFor("llama-server")).toEqual({ newest: "b5", since: t0.toISOString() });
  await checkEngineUpdates({ fetcher: async () => release("b5"), now: later(ENGINE_UPDATE_CHECK_INTERVAL_MS + 1) });
  expect(engineUpdateFor("llama-server")).toEqual({ newest: "b5", since: t0.toISOString() });
  // A still newer tag starts its own date.
  await checkEngineUpdates({ fetcher: async () => release("b6"), now: later(2 * ENGINE_UPDATE_CHECK_INTERVAL_MS + 2) });
  expect(engineUpdateFor("llama-server")).toEqual({ newest: "b6", since: later(2 * ENGINE_UPDATE_CHECK_INTERVAL_MS + 2).toISOString() });
});

test("installing the newer build clears the record, at the next check or the next read", async () => {
  await checkEngineUpdates({ fetcher: async () => release("b5"), now: t0 });
  expect(engineUpdateFor("llama-server")).not.toBeNull();
  await installBuild("b5");
  expect(engineUpdateFor("llama-server")).toBeNull();
  rmSync(engineTagRoot("llama-server", "b5"), { recursive: true, force: true });
});

test("a release no newer than the installed build leaves no record", async () => {
  await checkEngineUpdates({ fetcher: async () => release("b1"), now: t0 });
  expect(engineUpdateFor("llama-server")).toBeNull();
});

test("a failed or malformed fetch keeps the old record and says nothing", async () => {
  await checkEngineUpdates({ fetcher: async () => release("b5"), now: t0 });
  const fails: Array<() => Promise<Response>> = [async () => { throw new Error("offline"); }, async () => new Response("rate limited", { status: 403 }), async () => new Response("not json", { status: 200 }), async () => release("nightly")];
  for (const [index, fetcher] of fails.entries()) {
    await checkEngineUpdates({ fetcher, now: later((index + 1) * ENGINE_UPDATE_CHECK_INTERVAL_MS) });
    expect(engineUpdateFor("llama-server")).toEqual({ newest: "b5", since: t0.toISOString() });
  }
});

test("a check runs at most once every 12 hours unless asked", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return release("b5"); };
  await checkEngineUpdates({ fetcher, now: t0 });
  await checkEngineUpdates({ fetcher, now: later(ENGINE_UPDATE_CHECK_INTERVAL_MS - 1) });
  expect(calls).toBe(1);
  await checkEngineUpdates({ fetcher, now: later(ENGINE_UPDATE_CHECK_INTERVAL_MS - 1), force: true });
  expect(calls).toBe(2);
  await checkEngineUpdates({ fetcher, now: later(2 * ENGINE_UPDATE_CHECK_INTERVAL_MS) });
  expect(calls).toBe(3);
});

test("a request that never answers is cut off by a 10 second timeout signal", async () => {
  let signal: AbortSignal | undefined;
  await checkEngineUpdates({ fetcher: async (_url, init) => { signal = init?.signal ?? undefined; return release("b1"); }, now: t0 });
  expect(signal).toBeDefined();
});

test("nothing is fetched when update checks are off, even when asked", async () => {
  await checkEngineUpdates({ fetcher: async () => release("b5"), now: t0 });
  updateSettings({ "stack.updates.enabled": false });
  let calls = 0;
  await checkEngineUpdates({ fetcher: async () => { calls++; return release("b9"); }, now: later(5 * ENGINE_UPDATE_CHECK_INTERVAL_MS), force: true });
  expect(calls).toBe(0);
});

test("the engines listing serves update on the llama-server pin for this machine and null elsewhere", async () => {
  await checkEngineUpdates({ fetcher: async () => release("b5"), now: t0 });
  const body = await (await app.request("/stack/v1/engines")).json() as { engines: Array<{ name: string; matchesThisMachine: boolean; update?: { newest: string; since: string } | null }> };
  const mine = body.engines.filter((engine) => engine.name === "llama-server" && engine.matchesThisMachine);
  if (mine.length > 0) expect(mine[0]!.update).toEqual({ newest: "b5", since: t0.toISOString() });
  for (const engine of body.engines.filter((entry) => entry.name !== "llama-server")) expect(engine.update ?? null).toBeNull();
});
