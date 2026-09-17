import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appendLogLine, registerLogSecret } from "@/lib/log";
import { dataDir } from "@/lib/paths";

const logDir = join(dataDir, "logs");
const name = `test-${Date.now()}`;

afterEach(() => {
  if (existsSync(logDir)) for (const entry of readdirSync(logDir)) if (entry.startsWith(`${name}.log`)) rmSync(join(logDir, entry), { force: true });
});

test("the logger redacts credentials and rotates by size", () => {
  const clientKey = `mps_${"x".repeat(43)}`;
  const pepper = `pepper-${"y".repeat(32)}`;
  registerLogSecret(clientKey);
  registerLogSecret(pepper);
  appendLogLine(`key=${clientKey} pepper=${pepper}`, name);
  const path = join(logDir, `${name}.log`);
  expect(readFileSync(path, "utf8")).not.toContain(clientKey);
  expect(readFileSync(path, "utf8")).not.toContain(pepper);
  appendLogLine("x".repeat(20 * 1024 * 1024), name);
  appendLogLine("after rotation", name);
  expect(readdirSync(logDir).some((entry) => entry.startsWith(`${name}.log.`))).toBe(true);
});
