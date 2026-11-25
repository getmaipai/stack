import { describe, expect, test } from "bun:test";
import { featureOf, featureLocations, cancelBatch, modelIdsForFeature, moveBatchRunning, startBatch } from "@/lib/featureMoves";

import { upsertModel, removeModel } from "@/lib/modelStore";
describe("feature moves", () => {
  test("a feature with installed files reports its drive; one with none is left out", () => {
    upsertModel({ id: "qwen3.8-27b-ud-q4-k-m", roles: ["coding"], source: "catalog", provenance: {}, revision: "r1", modelPath: "/tmp/stack-loc-test.gguf", sha256: null });
    try {
      const coding = featureLocations().find((f) => f.feature_id === "coding");
      expect(coding?.drive_ids).toEqual(["main"]); expect(coding?.drives[0]?.connected).toBe(true);
      expect(featureLocations().find((f) => f.feature_id === "video")).toBeUndefined();
    } finally { removeModel("qwen3.8-27b-ud-q4-k-m"); }
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
