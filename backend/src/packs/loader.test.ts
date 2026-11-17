import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { loadPacks, packs, packFor, partsServing } from "@/packs/loader";
import { PACK_SOURCES } from "@/packs/index.generated";
import { renderManifest } from "@/packs/gen";
import { IMAGE_FAMILIES } from "@/images/models";
import { PART_DEFS } from "@/lib/partDefs";

const packsDir = join(import.meta.dir);
const srcDir = join(import.meta.dir, "..");

describe("model packs: format and boot validation (MODELPACK-STACK-01)", () => {
  test("every pack folder loads and validates", () => {
    expect(packs().length).toBe(PACK_SOURCES.length);
    expect(packs().length).toBeGreaterThan(0);
  });
  test("the generated manifest lists every pack folder (run `bun run src/packs/gen.ts`)", () => {
    expect(readFileSync(join(packsDir, "index.generated.ts"), "utf8")).toBe(renderManifest(packsDir));
  });
  test("a pack that does not match the spec stops the Stack", () => {
    expect(() => loadPacks([{ dir: "x", pack: { id: "x" }, recipes: {} }], new Set(["x"]))).toThrow(/invalid/);
  });
  test("a pack naming a part the table lacks stops the Stack", () => {
    const [first] = PACK_SOURCES;
    expect(() => loadPacks([first!], new Set())).toThrow(/part table does not have/);
  });
  test("a missing recipe stops the Stack", () => {
    const [first] = PACK_SOURCES;
    expect(() => loadPacks([{ ...first!, recipes: {} }])).toThrow(/recipe/);
  });
  test("a pack folder is named for its part", () => {
    const [first] = PACK_SOURCES;
    expect(() => loadPacks([{ ...first!, dir: "other" }])).toThrow(/named for its part/);
  });
  test("a pack's part is in the part table", () => {
    const ids = new Set(PART_DEFS.map((p) => p.id));
    for (const p of packs()) expect(ids.has(p.pack.part)).toBe(true);
  });
  test("packs serve jobs through the lookup", () => {
    expect(partsServing("picture").length).toBe(packs().filter((p) => p.pack.jobs.some((j) => j.job === "picture")).length);
    expect(packFor("no-such-part")).toBeNull();
  });
});

// Parity (written first): a pack says what the Stack's existing tables say today.
describe("model packs: parity with today's picture family table", () => {
  for (const p of packs()) {
    const family = (IMAGE_FAMILIES as Record<string, (typeof IMAGE_FAMILIES)[keyof typeof IMAGE_FAMILIES]>)[p.pack.part];
    if (!family) continue;
    test(`${p.pack.part}: steps, peaks, text and edit match the family table`, () => {
      const picture = p.pack.jobs.find((j) => j.job === "picture")!;
      const edit = p.pack.jobs.find((j) => j.job === "picture_edit");
      expect(picture.limits.steps_fixed).toBe(family.stepsDefault === family.stepsMax);
      expect(picture.capabilities.text).toBe(!!family.textCapable);
      expect(picture.peaks.find((x) => x.level === "standard")!.bytes).toBe(family.peak.gen8);
      expect(!!edit).toBe(family.edit);
      if (edit) expect(edit.peaks.find((x) => x.level === "standard")!.bytes).toBe(family.peak.edit);
    });
  }
});

// Rule E8: a model's name or part id belongs in its pack folder and the part table, not in routes or shared libraries. Files that
// predate the rule are in the baseline; the baseline may only shrink (a new file or a higher count fails).
const BRAND = /\b(minimax|h3-image|flux ?[23]|klein|ltx-?2|z-image|ernie|qwen-image|ace-step|wan ?2|fastwan)\b/gi;
const EXEMPT = (rel: string) => rel.startsWith("packs/") || rel === "lib/partDefs.ts" || rel.endsWith(".test.ts");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) { const full = join(dir, name); statSync(full).isDirectory() ? walk(full, out) : /\.ts$/.test(name) && out.push(full); }
  return out;
}
describe("rule E8: no model name outside its pack", () => {
  const counts: Record<string, number> = {};
  for (const file of walk(srcDir)) {
    const rel = relative(srcDir, file);
    if (EXEMPT(rel)) continue;
    const n = (readFileSync(file, "utf8").match(BRAND) ?? []).length;
    if (n) counts[rel] = n;
  }
  const baselinePath = join(packsDir, "brand-baseline.json");
  const baseline: Record<string, number> = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {};
  test("no file gains a model name, and no new file carries one (the baseline only shrinks; regenerate with UPDATE_PACK_BASELINE=1 only when it shrank)", () => {
    if (process.env.UPDATE_PACK_BASELINE === "1") { require("node:fs").writeFileSync(baselinePath, JSON.stringify(counts, null, 1) + "\n"); return; }
    const grew = Object.entries(counts).filter(([f, n]) => n > (baseline[f] ?? 0)).map(([f, n]) => `${f}: ${n} (baseline ${baseline[f] ?? 0})`);
    expect(grew).toEqual([]);
  });
});
