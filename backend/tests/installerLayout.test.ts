// Home's installer fetches the Stack at a pinned commit, places only the Commons tags that
// backend/package.json names, then runs `bun install` in backend/ and scripts/build-binary.sh.
// A root workspace that needs any other package (admin-ui's @maipai/ui did, 2026-11-21) makes
// that install fail with ENOENT and rolls the hub ship back. This keeps the root honest.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const json = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

describe("installer layout", () => {
  test("the root workspaces never include a package the installer does not place", () => {
    const ws: string[] = json("package.json").workspaces ?? [];
    expect(ws.filter((w) => w !== "backend")).toEqual([]);
    const placed = new Set(Object.entries(json("backend/package.json").dependencies ?? {}).filter(([, v]) => String(v).startsWith("file:")).map(([k, v]) => `${k}=${v}`));
    for (const w of ws) {
      const deps = json(`${w}/package.json`).dependencies ?? {};
      for (const [k, v] of Object.entries(deps)) if (String(v).startsWith("file:")) expect(placed.has(`${k}=${v}`)).toBe(true);
    }
  });
  test("admin-ui is built apart and optionally by build-binary.sh", () => {
    const script = readFileSync(join(root, "scripts/build-binary.sh"), "utf8");
    expect(script).toContain("REQUIRE_ADMIN_UI");
    expect(readFileSync(join(root, "scripts/release-stack.sh"), "utf8")).toContain("REQUIRE_ADMIN_UI=1");
  });
});
