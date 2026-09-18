import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const userDocs = join(import.meta.dir, "../../docs/user");

test("every user-guide screenshot link has a capture", () => {
  for (const file of readdirSync(userDocs).filter((entry) => entry.endsWith(".md"))) {
    const page = readFileSync(join(userDocs, file), "utf8");
    for (const match of page.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1];
      if (!target) continue;
      expect(existsSync(join(userDocs, target)), `${file} links to ${target}`).toBe(true);
    }
  }
});
