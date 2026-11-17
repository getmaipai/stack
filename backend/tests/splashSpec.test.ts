// ENGINESPEC-STACK-01: Splash's floors, tiers and defaults are data in src/engines/splash/engine.json. These tests tie that file to the
// values the code held before it moved (so the move changed no behavior) and show a broken file stops the Stack.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSplashSpec, splashSpec } from "@/engines/splash/spec";
import { SPLASH_MIN_CHIP_GENERATION, SPLASH_MIN_MACOS, SPLASH_MIN_MEMORY_GB, SPLASH_REASONING_EFFORT, SPLASH_TIERS, splashDraftPossible, splashDraftWanted, splashUnsupportedReason } from "@/lib/splash";

test("the data file holds the values the constants held before the move", () => {
  expect(SPLASH_MIN_MEMORY_GB).toBe(36);
  expect(SPLASH_MIN_CHIP_GENERATION).toBe(3);
  expect([...SPLASH_MIN_MACOS]).toEqual([26, 4]);
  expect([...SPLASH_TIERS]).toEqual(["p64", "p128"]);
  expect(SPLASH_REASONING_EFFORT).toBe("medium");
});

test("splash.ts reads the file, not its own copy", () => {
  const raw = JSON.parse(readFileSync(join(import.meta.dir, "../src/engines/splash/engine.json"), "utf8"));
  expect(loadSplashSpec(raw)).toEqual(splashSpec());
  expect(SPLASH_MIN_MEMORY_GB).toBe(raw.floors.memory_gb);
  expect(SPLASH_MIN_CHIP_GENERATION).toBe(raw.floors.chip_generation);
  expect([...SPLASH_MIN_MACOS]).toEqual(raw.floors.macos);
  expect([...SPLASH_TIERS]).toEqual(raw.tiers);
  expect(SPLASH_REASONING_EFFORT).toBe(raw.defaults.reasoning_effort);
});

test("the decisions the floors drive are unchanged", () => {
  const ok = { platform: "darwin", arch: "arm64", chipGeneration: 3, chipName: "Apple M3", memoryGb: 36, osVersion: "26.4", tier: "p64" as const };
  expect(splashUnsupportedReason(ok)).toBeNull();
  expect(splashUnsupportedReason({ ...ok, chipGeneration: 2 })).toContain("M3 chip or newer");
  expect(splashUnsupportedReason({ ...ok, memoryGb: 35 })).toContain("36 GB");
  expect(splashUnsupportedReason({ ...ok, osVersion: "26.3.1" })).toContain("26.4");
  expect(splashUnsupportedReason({ ...ok, tier: "p32" })).toContain("64 GB");
  expect(splashDraftPossible({ platform: "darwin", arch: "arm64" }, { generation: 2 })).toBe(false);
  expect(splashDraftWanted({ platform: "darwin", arch: "arm64" }, "p64", null)).toBe(true);
  expect(splashDraftWanted({ platform: "darwin", arch: "arm64" }, "p32", null)).toBe(false);
});

test("a broken engine file stops the Stack with the file and the fix in the message", () => {
  const good = JSON.parse(readFileSync(join(import.meta.dir, "../src/engines/splash/engine.json"), "utf8"));
  expect(() => loadSplashSpec({ ...good, floors: { ...good.floors, memory_gb: "36" } })).toThrow(/engine\.json/);
  expect(() => loadSplashSpec({ ...good, tiers: ["p999"] })).toThrow(/invalid/);
  expect(() => loadSplashSpec({ ...good, tiers: [] })).toThrow(/invalid/);
  expect(() => loadSplashSpec({ ...good, extra: 1 })).toThrow(/invalid/);
  expect(() => loadSplashSpec({ ...good, floors: { memory_gb: 36 } })).toThrow(/invalid/);
});
