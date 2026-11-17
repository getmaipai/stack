import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { loadPacks, packs, packFor, partsServing } from "@/packs/loader";
import { PACK_SOURCES } from "@/packs/index.generated";
import { renderManifest } from "@/packs/gen";
import { IMAGE_FAMILIES } from "@/images/models";
import { PART_DEFS } from "@/lib/partDefs";
import { LTX25_MEASURED, LTX25_MAX_MEASURED, LTX25_INGREDIENTS_PEAK_MEASURED_BYTES, LTX25_INGREDIENTS_MAX_SECONDS } from "@/video/ltx25";

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
  test("a pack never widens its part's audience: an adult-only part's jobs are adult only", () => {
    for (const p of packs()) if (PART_DEFS.find((d) => d.id === p.pack.part)!.adultOnly) for (const j of p.pack.jobs) expect(j.audiences).toEqual(["adult"]);
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

describe("model packs: parity with today's LTX-2.5 tables", () => {
  const find = (part: string, job: string) => packFor(part)!.pack.jobs.find((j) => j.job === job)!;
  test("the Standard and Boost pack rows equal the measured rows", () => {
    const clip = find("ltx-2-5-q8-distilled-mlx", "clip");
    const standard = LTX25_MEASURED.find((r) => r.profile === "standard")!;
    const boost = LTX25_MEASURED.find((r) => r.size === "768x448")!;
    expect(clip.limits.shapes!.landscape!.standard).toEqual({ width: standard.width, height: standard.height });
    expect(clip.limits.max_seconds!.standard).toBe(standard.maxSeconds);
    expect(clip.peaks.find((x) => x.level === "standard")!.bytes).toBe(Math.floor(standard.peakBytes));
    expect(clip.limits.shapes!.landscape!.boost).toEqual({ width: boost.width, height: boost.height });
    expect(clip.limits.max_seconds!.boost).toBe(boost.maxSeconds);
    expect(clip.peaks.find((x) => x.level === "boost")!.bytes).toBe(Math.floor(boost.peakBytes));
  });
  test("the Max pack row and the sheet clip equal the Max and Ingredients constants", () => {
    const max = LTX25_MAX_MEASURED[0]!;
    const clip = find("ltx-2-5-bf16-distilled-mlx-max", "clip");
    expect(clip.limits.shapes!.landscape!.max).toEqual({ width: max.width, height: max.height });
    expect(clip.limits.max_seconds!.max).toBe(max.maxSeconds);
    expect(clip.peaks[0]!.bytes).toBe(Math.floor(max.peakBytes));
    const sheet = find("ltx-2-5-bf16-distilled-mlx-max", "clip_from_sheet");
    expect(sheet.limits.max_seconds!.standard).toBe(LTX25_INGREDIENTS_MAX_SECONDS);
    expect(sheet.peaks[0]!.bytes).toBe(Math.floor(LTX25_INGREDIENTS_PEAK_MEASURED_BYTES));
  });
  test("every video pack serves adults only, as its part row says", () => {
    for (const part of ["ltx-2-5-q8-distilled-mlx", "ltx-2-5-bf16-distilled-mlx-max", "minimax-h3"]) {
      expect(PART_DEFS.find((d) => d.id === part)!.adultOnly).toBe(true);
      for (const j of packFor(part)!.pack.jobs) expect(j.audiences).toEqual(["adult"]);
    }
  });
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
