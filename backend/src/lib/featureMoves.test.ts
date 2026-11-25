import { describe, expect, test } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { featureOf, featureLocations, cancelBatch, modelIdsForFeature, moveBatchRunning, moveTargets, startBatch } from "@/lib/featureMoves";

import { upsertModel, removeModel } from "@/lib/modelStore";
describe("feature moves", () => {
  test("a feature with installed files reports its drive; one with none is left out", () => {
    writeFileSync("/tmp/stack-loc-test.gguf", "x");
    upsertModel({ id: "qwen3.8-27b-ud-q4-k-m", roles: ["coding"], source: "catalog", provenance: {}, revision: "r1", modelPath: "/tmp/stack-loc-test.gguf", sha256: null });
    try {
      const coding = featureLocations().find((f) => f.feature_id === "coding");
      expect(coding?.drive_ids).toEqual(["main"]); expect(coding?.drives[0]?.connected).toBe(true);
      expect(featureLocations().find((f) => f.feature_id === "video")).toBeUndefined();
    } finally { removeModel("qwen3.8-27b-ud-q4-k-m"); rmSync("/tmp/stack-loc-test.gguf", { force: true }); }
  });
  test("a model belongs to the feature its disk row names", () => {
    expect(featureOf("qwen3.8-27b-ud-q4-k-m")).toBe("coding"); expect(featureOf("no-such-model")).toBeNull();
  });
  test("an unknown feature is refused in plain words", () => {
    expect(() => modelIdsForFeature("no-such-feature")).toThrow("There is no feature called");
  });
  test("a batch unloads the feature, moves each model in order, and allows one batch at a time", async () => {
    const calls: string[] = []; let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = (async (id: string, to: string, opts: { hooks?: { afterVerify?: () => unknown; afterSwitch?: () => unknown } }) => { calls.push(`run:${id}:${to}`); await gate; await opts.hooks?.afterVerify?.(); await opts.hooks?.afterSwitch?.(); }) as never;
    const unload = async (role: string) => { calls.push(`unload:${role}`); };
    const batch = startBatch(["a", "b"], "usb", ["coding"], { run, unload });
    expect(moveBatchRunning()).toBe(true);
    expect(() => startBatch(["c"], "usb", [], { run, unload })).toThrow("Another move is running");
    release(); await batch;
    expect(moveBatchRunning()).toBe(false);
    expect(calls).toEqual(["unload:coding", "run:a:usb", "unload:coding", "unload:coding", "run:b:usb", "unload:coding", "unload:coding"]);
    expect(cancelBatch()).toBe(false);
  });
  test("a failed model ends the batch and frees the slot", async () => {
    const run = (async () => { throw new Error("did not verify"); }) as never;
    await expect(startBatch(["a"], "usb", [], { run, unload: async () => undefined })).rejects.toThrow("did not verify");
    expect(moveBatchRunning()).toBe(false);
  });
});

describe("moves skip models that were never downloaded", () => {
  const file = "/tmp/stack-move-skip-installed.bin";
  const rec = (id: string, modelPath: string) => upsertModel({ id, roles: ["video"], source: "catalog", provenance: {}, revision: "r1", modelPath, sha256: null });
  const ids = ["ltx-2-5-q8-distilled-mlx", "fastwan2-2-ti2v-5b-mlx-bf16", "sam2.1-hiera-small"];
  const cleanup = () => { for (const id of ids) removeModel(id); rmSync(file, { force: true }); };
  test("one installed model and two records without files: only the installed one moves, the others are listed as skipped", () => {
    writeFileSync(file, "x");
    try {
      rec(ids[0]!, file); rec(ids[1]!, "/tmp/stack-move-skip-missing-1"); rec(ids[2]!, "/tmp/stack-move-skip-missing-2");
      expect(modelIdsForFeature("video")).toEqual([ids[0]!]);
      const targets = moveTargets("video", undefined);
      expect(targets.present).toEqual([ids[0]!]);
      expect([...targets.skipped].sort()).toEqual([ids[1]!, ids[2]!].sort());
      expect(targets.message).toContain("2 not downloaded, skipped");
      expect(moveTargets(undefined, [ids[0]!, ids[1]!]).skipped).toEqual([ids[1]!]);
    } finally { cleanup(); }
  });
  test("a feature with nothing installed gives a plain message and nothing to move", () => {
    try {
      rec(ids[1]!, "/tmp/stack-move-skip-missing-1");
      const targets = moveTargets("video", undefined);
      expect(targets.present).toEqual([]); expect(targets.skipped).toEqual([ids[1]!]);
      expect(targets.message).toContain("Nothing to move");
    } finally { cleanup(); }
  });
});
