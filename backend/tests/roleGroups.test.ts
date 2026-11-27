// The supervisor's role groups come from role flags in roles.ts, not from
// hard-coded lists (readers/rolegroups). Compare as sets: the derived arrays
// are in ROLE_IDS order, the copies below keep the old literal order.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rolesWith } from "@/roles";

const SPAWNABLE = ["chat", "coding", "judge", "embed", "rerank", "vision", "stt", "tts", "image", "helper"];
const SPEECH = ["stt"];
const MANAGED = ["tts", "image"];
const GENERATOR = ["image"];
const JIT = ["vision", "coding", "helper"];

const sorted = (ids: string[]): string[] => [...ids].sort();

test("rolesWith returns the five former hard-coded lists as sets", () => {
  expect(sorted(rolesWith("spawnable"))).toEqual(sorted(SPAWNABLE));
  expect(sorted(rolesWith("speechWorker"))).toEqual(sorted(SPEECH));
  expect(sorted(rolesWith("managedEngine"))).toEqual(sorted(MANAGED));
  expect(sorted(rolesWith("generator"))).toEqual(sorted(GENERATOR));
  expect(sorted(rolesWith("jitAdmitted"))).toEqual(sorted(JIT));
});

test("supervisor.ts no longer hard-codes the speech or jit role lists", () => {
  const text = readFileSync(join(import.meta.dir, "..", "src", "lib", "supervisor.ts"), "utf8");
  expect(text.includes('["stt"]')).toBe(false);
  expect(text.includes('["vision", "coding", "helper"]')).toBe(false);
});
