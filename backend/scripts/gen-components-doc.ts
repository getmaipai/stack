// Generates docs/components.md from the catalog modules. Run with:
// bun run gen:components-doc (from backend/), then commit the result;
// scripts/check.sh regenerates and diffs it.
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// modelCatalog.ts reaches settings.ts and the database through hf.ts, so
// the generator must never open a real data directory; the scratch one
// is removed at exit.
let scratch: string | null = null;
if (!process.env.STACK_DATA_DIR) { scratch = mkdtempSync(join(tmpdir(), "maipai-stack-components-doc-")); process.env.STACK_DATA_DIR = scratch; }
process.on("exit", () => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });
const { collectComponentsCatalog, renderComponentsDoc } = await import("../src/lib/componentsDoc");

const outPath = join(import.meta.dir, "..", "..", "docs", "components.md");
writeFileSync(outPath, `${renderComponentsDoc(collectComponentsCatalog())}\n`);
console.log(`Wrote the components inventory to ${outPath}`);
