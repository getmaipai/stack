import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// A compiled binary (bun build --compile) has no repo checkout beside it. The spec interpreters read their
// vocab JSON from disk at import time, so importing one takes the compiled Stack down at startup
// (2026-10-28: "ENOENT open /vocab/setting-reasons.json" on the Studio). scripts/build-binary.sh's live verify
// catches it too; this test catches it in the quick gate.
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

test("no Stack source imports a spec interpreter that reads files at import time", () => {
  const offenders = sources(join(import.meta.dir, "..", "src")).filter((file) => /from\s+["']@maipai\/spec\/interpreters\//.test(readFileSync(file, "utf8")));
  expect(offenders).toEqual([]);
});
