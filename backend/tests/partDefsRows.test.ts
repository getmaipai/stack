import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PART_DEFS, partDef, type PartDef } from "@/lib/partDefs";
import rowsJson from "@/rows/partDefs.json";

const rows: readonly PartDef[] = rowsJson as unknown as readonly PartDef[];

describe("partDefs rows data file", () => {
  test("PART_DEFS equals the imported JSON rows", () => {
    expect(PART_DEFS).toEqual(rows);
  });

  test("the table has at least 50 rows", () => {
    expect(PART_DEFS.length).toBeGreaterThanOrEqual(50);
  });

  test("ids are unique", () => {
    const ids = PART_DEFS.map((part) => part.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every row has labels, a description and a valid kind", () => {
    for (const part of PART_DEFS) {
      expect(part.label.length).toBeGreaterThan(0);
      expect(part.neutralLabel.length).toBeGreaterThan(0);
      expect(part.description.length).toBeGreaterThan(0);
      expect(["model", "tool", "engine"]).toContain(part.kind);
    }
  });

  test("ffmpeg is a tool", () => {
    expect(partDef("ffmpeg")?.kind).toBe("tool");
  });

  test("no model id is written in the logic file", () => {
    const text = readFileSync(resolve(import.meta.dir, "../src/lib/partDefs.ts"), "utf8");
    expect(text).not.toMatch(/["'`](qwen|flux|ernie|ace-step|chatterbox|pocket|voxcpm|moonshine|parakeet|nomic|ltx|sam2|minimax|fastwan|z-image|seedvr)/);
  });
});
