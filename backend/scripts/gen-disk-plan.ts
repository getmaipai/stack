// Writes docs/disk-plan.json: every tier's disk plan, for the clients that
// run before a Stack exists (Home's installer and setup checks copy it).
// bun run gen:disk-plan (from backend/); scripts/check.sh regenerates and diffs it.
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let scratch: string | null = null;
if (!process.env.STACK_DATA_DIR) { scratch = mkdtempSync(join(tmpdir(), "maipai-stack-disk-plan-doc-")); process.env.STACK_DATA_DIR = scratch; }
process.on("exit", () => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });
const { diskPlanExport } = await import("../src/lib/diskPlan");

const outPath = join(import.meta.dir, "..", "..", "docs", "disk-plan.json");
writeFileSync(outPath, `${JSON.stringify(diskPlanExport(), null, 2)}\n`);
console.log(`Wrote the disk plan to ${outPath}`);
