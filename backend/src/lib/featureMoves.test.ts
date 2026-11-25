import { describe, expect, test } from "bun:test";
import { cancelBatch, modelIdsForFeature, moveBatchRunning, startBatch } from "@/lib/featureMoves";

describe("feature moves", () => {
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
