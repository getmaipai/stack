import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { StackPart } from "@maipai/spec/stack/ts/stack-part.js";
import { componentDefs, listComponents } from "@/lib/components";
import { diskPlanForTier } from "@/lib/diskPlan";
import { PART_DEFS, partDef, stackParts } from "@/lib/parts";
import { tierCandidateLabel } from "@/lib/tiers";
import { ENGINE_BINARIES } from "@/lib/engineCatalog";
import { PART_DEFS as ALL_PART_DEFS } from "@/lib/partDefs";

describe("canonical parts", () => {
  test("part definitions cover each component exactly once", () => {
    const ids = PART_DEFS.filter((part) => part.kind !== "engine").map((part) => part.id);
    const unitIds = componentDefs().map((unit) => unit.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...unitIds].sort());
    for (const unit of componentDefs()) expect(partDef(unit.id)).toBeDefined();
  });

  test("engine definitions cover every runner and pinned binary, with no unused engine rows", () => {
    const { STACK_MODELS } = require("@/lib/modelCatalog") as typeof import("@/lib/modelCatalog");
    const runners = STACK_MODELS.map((pin) => pin.engine).filter((value): value is string => !!value);
    const required = new Set([...runners, ...ENGINE_BINARIES.map((pin) => pin.name)]);
    const aliases = new Map([["mflux", "image-gen"], ["chatterbox-turbo", "chatterbox-vc"], ["voxcpm2-reduced", "voxcpm2"], ["voxcpm2-stt", "voxcpm2"]]);
    const expected = new Set([...required].map((id) => aliases.get(id) ?? id));
    // A runner that is already a tool part (image-tools, liveportrait, score-gen) has no second engine row.
    const engineDefs = ALL_PART_DEFS.filter((part) => part.kind !== "model");
    const declared = new Set(engineDefs.map((part) => part.id));
    expect([...expected].every((id) => declared.has(id))).toBe(true);
    expect(["beats", "minimax-h3-video-gen", "face-repair"].every((id) => declared.has(id))).toBe(true);
    expect(new Set(ALL_PART_DEFS.map((part) => part.id)).size).toBe(ALL_PART_DEFS.length);
    for (const id of expected) expect(declared.has(id)).toBe(true);
  });

  test("stack part files preserve each downloadable component pin", () => {
    const parts = stackParts();
    for (const part of parts) {
      const unit = componentDefs().find((candidate) => candidate.id === part.id)!;
      const expected = unit.pins.flatMap((pin) => {
        const download = pin.download;
        if (!download) return [];
        if (download.files?.length) {
          const base = download.url.slice(0, download.url.lastIndexOf("/") + 1);
          return download.files.map((file) => ({ url: new URL(file.path, base).href, sha256: file.sha256, bytes: file.bytes }));
        }
        return [{ url: download.url, sha256: download.sha256, bytes: download.approx_bytes }];
      });
      const actual = part.files.map(({ url, sha256, bytes }) => ({ url, sha256, bytes }));
      expect(new Set(actual.map((file) => JSON.stringify(file)))).toEqual(new Set(expected.map((file) => JSON.stringify(file))));
    }
  });

  test("every stack part parses with the pinned spec", () => {
    for (const part of stackParts()) expect(StackPart.safeParse(part).success).toBe(true);
  });

  test("spoken video output is adult only and child video is separate", () => {
    for (const part of PART_DEFS.filter(({ id }) => id.startsWith("ltx-2-5-") || id === "minimax-h3")) expect(part.adultOnly).toBe(true);
    for (const part of PART_DEFS) expect(Boolean(part.adultOnly && part.minorOnly)).toBe(false);
  });

  test("display names live in parts.ts, except stable IDs", () => {
    const files = ["components.ts", "tiers.ts", "diskPlan.ts", "installPlan.ts"].map((name) => readFileSync(resolve(import.meta.dir, "../src/lib", name), "utf8"));
    const source = files.join("\n");
    for (const part of PART_DEFS.filter((row) => row.kind !== "engine")) if (part.label.length > 6) expect(source).not.toContain(part.label);
    for (const forbidden of ["Wan2.2", "Wan 2.2", "Wan Video", "FastWan"]) expect(source).not.toContain(forbidden);
  });

  test("Wan labels shown by the component, candidate, and disk plan are neutral", async () => {
    const id = "fastwan2-2-ti2v-5b-mlx-bf16";
    const neutral = partDef(id)!.neutralLabel;
    const components = await listComponents();
    expect(components.components.find((component) => component.id === id)?.label).toBe(neutral);
    expect(tierCandidateLabel(id)).toBe(neutral);
    expect(diskPlanForTier("p128")?.rows.find((row) => row.id === "video")?.label).toBe(neutral);
  });
});
