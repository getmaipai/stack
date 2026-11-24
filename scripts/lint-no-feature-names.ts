/**
 * Lint: find feature ids, hardware template ids and model ids hard-coded as
 * string literals in backend/src logic, so later steps can move them into
 * data rows. See task brief. Run with bun.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const FEATURE_IDS = [
  "chat",
  "coding",
  "pictures",
  "video",
  "music",
  "voice",
  "stt",
  "embeddings",
  "vision",
  "wakeword",
  "stems",
];

export const TEMPLATE_IDS = ["p16", "p32", "p64", "p128"];

const MODEL_PREFIXES = [
  "qwen",
  "parakeet",
  "moonshine",
  "nomic",
  "flux",
  "ernie",
  "ace-step",
  "chatterbox",
  "fish-audio",
  "ltx",
  "whisper",
];

export type Site = {
  file: string;
  line: number;
  literal: string;
  kind: "feature" | "template" | "model";
};

function isModelId(content: string): boolean {
  if (content !== content.toLowerCase()) return false;
  if (!/\d/.test(content)) return false;
  if (!content.includes("-")) return false;
  return MODEL_PREFIXES.some((p) => content.startsWith(p));
}

function classify(content: string): Site["kind"] | null {
  if (FEATURE_IDS.includes(content)) return "feature";
  if (TEMPLATE_IDS.includes(content)) return "template";
  if (isModelId(content)) return "model";
  return null;
}

/** Find hard-coded id literals in one file's text. Line numbers are 1-based. */
export function findSites(file: string, text: string): Site[] {
  const sites: Site[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.replace(/^\s+/, "");
    // Skip comment lines.
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }
    // Drop trailing line comments ("// ...").
    const commentAt = raw.indexOf("// ");
    const code = commentAt >= 0 ? raw.slice(0, commentAt) : raw;
    const re = /"([^"\n]*)"|'([^'\n]*)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const literal = m[1] ?? m[2] ?? "";
      const kind = classify(literal);
      if (kind) sites.push({ file, line: i + 1, literal, kind });
    }
  }
  return sites;
}

/** Files that define the rows themselves; exempt from the lint. */
export const ALLOWED_FILES = [
  "backend/src/lib/choiceCategories.ts",
  "backend/src/profiles.ts",
  "backend/src/roles.ts",
  // Data tables, not logic: the part catalog (pins with download urls and hashes), the helper's knowledge text, its eval set, a pack's pins, and test files beside source.
  "backend/src/roles.ts",
  "backend/src/lib/modelCatalog.ts",
  // Data records: the engine-to-role table, the picture family specs (model records), and the choices API shape (its enum of feature ids).
  "backend/src/lib/engineCatalog.ts",
  "backend/src/images/models.ts",
  "backend/src/lib/choicesSchema.ts",
  "backend/src/lib/helperKnowledge.ts",
  "backend/src/bench/helperEvalSet.ts",
  "backend/src/packs/h3/h3Pins.ts",
  "backend/src/packs/loader.test.ts",
];

const ROOT = resolve(import.meta.dir, "..");
const BASELINE = join(ROOT, "scripts", "lint-no-feature-names.baseline.json");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else if (entry.endsWith(".ts")) out.push(abs);
  }
  return out.sort();
}

function collect(): Map<string, Site[]> {
  const result = new Map<string, Site[]>();
  const srcDir = join(ROOT, "backend", "src");
  for (const abs of walk(srcDir)) {
    const rel = relative(ROOT, abs).replaceAll("\\", "/");
    if (ALLOWED_FILES.includes(rel)) continue;
    const sites = findSites(rel, readFileSync(abs, "utf8"));
    if (sites.length > 0) result.set(rel, sites);
  }
  return result;
}

function runCli(): void {
  const flag = process.argv[2];
  const found = collect();
  if (flag === "--list") {
    for (const [file, sites] of found) {
      for (const s of sites) {
        console.log(`${s.file}:${s.line} ${s.literal} ${s.kind}`);
      }
    }
    return;
  }
  // Counts per file (unless listing individual sites).
  for (const [file, sites] of found) console.log(`${file}: ${sites.length}`);
  if (flag === "--write-baseline") {
    const baseline: Record<string, number> = {};
    for (const [file, sites] of found) baseline[file] = sites.length;
    writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`wrote ${BASELINE}`);
    return;
  }
  // Compare with baseline: regressions exit 1, shrinkage is a warning.
  if (!existsSync(BASELINE)) {
    console.error("no baseline; run with --write-baseline first");
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, number>;
  let failed = false;
  let shrunk = false;
  for (const [file, sites] of found) {
    const prev = baseline[file] ?? 0;
    if (sites.length > prev) {
      console.error(`${file}: count rose ${prev} -> ${sites.length}`);
      failed = true;
    } else if (sites.length < prev) {
      shrunk = true;
    }
  }
  for (const file of Object.keys(baseline)) {
    if (!found.has(file) && (baseline[file] ?? 0) > 0) shrunk = true;
  }
  if (shrunk) console.log("shrunk: update the baseline");
  if (failed) process.exit(1);
}

if (import.meta.main) runCli();
