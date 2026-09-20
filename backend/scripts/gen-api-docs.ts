// Generates docs/api/openapi.json from the live route registrations in
// app.ts. Run with: bun run gen:api-docs (from backend/), then commit the
// result - scripts/check.sh regenerates and diffs it.
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Generating the document must never open a real data directory: the
// app opens and migrates the database on import, so point it at a
// throwaway one unless the caller chose otherwise.
let scratch: string | null = null;
if (!process.env.STACK_DATA_DIR) { scratch = mkdtempSync(join(tmpdir(), "maipai-stack-api-docs-")); process.env.STACK_DATA_DIR = scratch; }
process.on("exit", () => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });
const { app } = await import("../src/app");
const packageJson = (await import("../../package.json")).default;

const document = app.getOpenAPIDocument({
  openapi: "3.0.0",
  info: { title: "MaiPai Stack API", version: packageJson.version },
});

const outDir = join(import.meta.dir, "..", "..", "docs", "api");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "openapi.json");
writeFileSync(outPath, JSON.stringify(document, null, 2) + "\n");
console.log(`Wrote the OpenAPI document (${Object.keys(document.paths ?? {}).length} paths) to ${outPath}`);
