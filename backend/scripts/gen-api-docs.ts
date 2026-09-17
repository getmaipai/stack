// Generates docs/api/openapi.json from the live route registrations in
// app.ts. Run with: bun run gen:api-docs (from backend/), then commit the
// result - scripts/check.sh regenerates and diffs it.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { app } from "../src/app";
import packageJson from "../../package.json";

const document = app.getOpenAPIDocument({
  openapi: "3.0.0",
  info: { title: "MaiPai Stack API", version: packageJson.version },
});

const outDir = join(import.meta.dir, "..", "..", "docs", "api");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "openapi.json");
writeFileSync(outPath, JSON.stringify(document, null, 2) + "\n");
console.log(`Wrote the OpenAPI document (${Object.keys(document.paths ?? {}).length} paths) to ${outPath}`);
