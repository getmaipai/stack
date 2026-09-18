import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readlinkSync, rmSync } from "node:fs";
import { engineCurrentPath, engineTagRoot } from "@/lib/store/layout";
import { swapEngine } from "@/updates/engines";

const name = `test-engine-${Date.now()}`;
afterEach(() => rmSync(engineTagRoot(name, "b1").split(`/${name}/`)[0] + `/${name}`, { recursive: true, force: true }));

test("engine swap relinks current to the staged tag", async () => {
  mkdirSync(engineTagRoot(name, "b1"), { recursive: true });
  mkdirSync(engineTagRoot(name, "b2"), { recursive: true });
  await swapEngine(name, "b1");
  expect(readlinkSync(engineCurrentPath(name))).toBe("b1");
  await swapEngine(name, "b2");
  expect(readlinkSync(engineCurrentPath(name))).toBe("b2");
});
