import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { StackVideoReceipt } from "@maipai/spec/stack/ts/stack-video-receipt.js";
import { aggregate, buildRows, joinScores, renderDelta, renderTable, validateSuite, type EvalResult } from "@/bench/videoEval";

const suitePath = resolve(import.meta.dir, "../../scripts/bench/video-eval.suite.json");
const validResult = { id: "job-1", job: "clip", state: "done", percent: 100, status: "Done", files: ["media-9"], poster: "media-10", made_with: { part: "clip-model-a", label: "Clip model A", pack_version: "1.0.0", shape: "landscape", seconds: 4, sound: true, notes: [], receipt: "job-1" } };
const fixture = StackVideoReceipt.parse({ version: 1, job_id: "job-1", operation: "generate", made_at: "2026-11-20T12:00:00Z", runtime: { id: "runtime-a", revision: "1" }, model: { id: "model-a", build: "build-a", quantization: null }, steps: { count: 20, schedule: "linear" }, adapter: null, inputs: [], requested: { width: 768, height: 512, frames: 121, seconds: 5 }, native: { width: 768, height: 512, frames: 121, fps: 24, seconds: 5, audio: true, bytes: 1000 }, delivered: { width: 768, height: 512, frames: 121, fps: 24, seconds: 5, audio: true, bytes: 900 }, delivered_is: "finished", seed: 4101, phases: [{ name: "load", ms: 120 }, { name: "generate", ms: 830 }], peak_memory_bytes: 123456, finish: [{ operation: "mux", from: { width: 768, height: 512 }, to: { width: 768, height: 512 }, ok: true, code: null }], prompt: { bytes: 2, sha256: "a".repeat(64) }, route: { name: "words", reason: "No pictures supplied." } });
const mk = (id: string, wall: number | null, peak: number | null, verdict: "pass" | "fail" | "not_run"): EvalResult => ({ id, arm: "arm", level: "standard", route: null, seed: 1, steps: null, schedule: null, adapter_id: null, wall_ms: wall, peak_memory_bytes: peak, requested: null, native: null, delivered: null, finish: [], checker: { verdict }, refusal: null, receipt: null });

describe("video evaluation harness", () => {
  test("suite follows StackMakeRequest and public persona constraints", () => {
    const suite = validateSuite(suitePath); const ids = new Set<string>(); const roster = new Set("alfred astro atlas bramble bruno clover cosmo daisy ember indigo iris juniper lucia marlow marsh mopey nadia nova oliver pippa quill raven riff rivet rover sage serena sprout tempo velvet vincent willow".split(" "));
    expect(suite.rows.length).toBeGreaterThanOrEqual(18);
    for (const row of suite.rows) { expect(ids.has(row.id)).toBe(false); ids.add(row.id); if (/\bH3\b/i.test(row.arm)) expect(row.private_testing).toBe(true); const desc = (row.request as { description: string }).description; for (const name of desc.match(/\b[a-z]+\b/g) ?? []) if (name === name.toLowerCase() && roster.has(name)) expect(roster.has(name)).toBe(true); }
  });
  test("buildRows sums phase times and preserves receipt measurements", () => { const built = buildRows(fixture, validResult); expect(built.wall_ms).toBe(950); expect(built.peak_memory_bytes).toBe(123456); expect(built.route).toBe("words"); });
  test("aggregate handles mixed verdicts and zero passes", () => { expect(aggregate([mk("a", 60000, 1, "pass"), mk("b", 120000, 2, "fail")])).toMatchObject({ minutes_per_accepted_take: 1, first_take_pass_rate: 0.5 }); expect(aggregate([mk("a", 10, 1, "fail")]).minutes_per_accepted_take).toBeNull(); expect(aggregate([]).first_take_pass_rate).toBeNull(); });
  test("delta reports percent and verdict flips", () => { const delta = renderDelta([mk("a", 150, 120, "pass")], [mk("a", 100, 100, "fail")]); expect(delta).toContain("50.0%"); expect(delta).toContain("20.0%"); expect(delta).toContain("fail → pass"); });
  test("scores join by row id and missing scores stay empty", () => { expect(joinScores([mk("a", null, null, "not_run"), mk("b", null, null, "not_run")], { a: { identity: 4 } }).map((row) => row.scores)).toEqual([{ identity: 4 }, null]); });
  test("refusals render typed code and line", () => { const row = { ...mk("a", null, null, "not_run"), refusal: { code: "level_not_served", line: "Choose standard." } }; expect(renderTable([row])).toContain("level_not_served: Choose standard."); });
});
