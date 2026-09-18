import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNEL_TYPES } from "@/lib/channels";

test("every channel type has a row in the Stack's privacy page", () => {
  const privacy = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/user/privacy.md"), "utf8");
  for (const type of CHANNEL_TYPES) {
    const row = privacy.split("\n").find((line) => line.toLowerCase().startsWith(`| ${type} `));
    expect(row, `docs/user/privacy.md must have a row naming the "${type}" channel`).toBeTruthy();
  }
});

test("every channel type appears in the alert channels contract row", () => {
  const integrations = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/integrations.md"), "utf8");
  const row = integrations.split("\n").find((line) => line.startsWith("| Alert channels |"));
  expect(row, "docs/integrations.md must have an Alert channels contract row").toBeTruthy();
  for (const type of CHANNEL_TYPES) {
    expect(row!.toLowerCase().includes(type), `the Alert channels row must name the "${type}" channel`).toBe(true);
  }
});
