import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_READY_MARKER } from "@/lib/engineCatalog";
import { __resetHealthForTests, list } from "@/lib/health";
import { engineCurrentPath, engineTagRoot } from "@/lib/store/layout";
import { previousEngine, swapEngine } from "@/updates/engines";

const name = `test-engine-${Date.now()}`;
afterEach(() => rmSync(engineTagRoot(name, "b1").split(`/${name}/`)[0] + `/${name}`, { recursive: true, force: true }));

/** A build that finished installing: its directory and its ready marker. */
function installed(tag: string): void {
  mkdirSync(engineTagRoot(name, tag), { recursive: true });
  writeFileSync(join(engineTagRoot(name, tag), ENGINE_READY_MARKER), "now");
}
/** A build whose download started and never finished: the directory alone. */
function staging(tag: string): void { mkdirSync(engineTagRoot(name, tag), { recursive: true }); }

test("engine swap relinks current to the staged tag", async () => {
  installed("b1");
  installed("b2");
  await swapEngine(name, "b1");
  expect(readlinkSync(engineCurrentPath(name))).toBe("b1");
  await swapEngine(name, "b2");
  expect(readlinkSync(engineCurrentPath(name))).toBe("b2");
});

test("a swap whose post-load check fails relinks the previous tag, raises failed-swap with a rollback fix, and remembers the previous tag", async () => {
  __resetHealthForTests();
  installed("b1");
  installed("b2");
  await swapEngine(name, "b1");
  let drained = false;
  await expect(swapEngine(name, "b2", { drain: async () => { drained = true; }, postLoadCheck: async () => false })).rejects.toThrow(/post-load check/);
  expect(drained).toBe(true);
  expect(readlinkSync(engineCurrentPath(name))).toBe("b1");
  const item = list().find((candidate) => candidate.code === "failed-swap");
  expect(item?.severity).toBe("critical");
  expect(item?.fix).toEqual({ label: "Roll back", action: "rollback_update" });
  expect(previousEngine(name)).toBe("b1");
});

test("a swap to a tag that is not installed, or whose download never finished, is refused and the link is untouched", async () => {
  installed("b1");
  await swapEngine(name, "b1");
  await expect(swapEngine(name, "b9")).rejects.toThrow(/not installed/);
  staging("b2");
  await expect(swapEngine(name, "b2")).rejects.toThrow(/not installed/);
  expect(readlinkSync(engineCurrentPath(name))).toBe("b1");
});
