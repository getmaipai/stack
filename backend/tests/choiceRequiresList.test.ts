// The `requires` list each category carries on the choices read (docs/dev/choices.md): the engines and drafts its candidates need.
// requiresFor is pure, so the rules are checked with plain fake candidates and parts; the read is checked through readChoices.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { __setChoicesDepsForTests, readChoices } from "@/lib/choices";
import { requiresFor, type RequiresPart } from "@/lib/choiceRequires";
import { CategorySchema, type Candidate } from "@/lib/choicesSchema";
import { __resetChoicesForTests } from "@/lib/choicesStore";
import { __resetPartChoicesForTests } from "@/lib/partChoices";
import { listParts } from "@/lib/partsList";
import { __resetSettingsForTests } from "@/settings";
import type { HardwareInfo } from "@/lib/hardware";

const hw = (gb: number): HardwareInfo => ({ platform: "darwin", arch: "arm64", totalRamGb: gb, cpuCount: 8, isAppleSilicon: true, unifiedMemoryGb: gb, cudaDevices: [], freeDiskBytes: 1e12, osVersion: "test" });

const cand = (id: string, engine: string | null): Candidate => ({ id, engine } as Candidate);
const part = (label: string): RequiresPart => ({ label, state: "installed", reason: null, size_bytes: 100, can_install: false, can_uninstall: true });

test("two candidates sharing one engine give one engine entry naming both", () => {
  const parts = new Map<string, RequiresPart>([["splash", part("Splash")]]);
  const rows = requiresFor([cand("marlow-splash", "splash"), cand("nova-splash", "splash")], (id) => parts.get(id), () => []);
  expect(rows.length).toBe(1);
  expect(rows[0]).toMatchObject({ id: "splash", kind: "engine", label: "Splash", needed_by: ["marlow-splash", "nova-splash"] });
});

test("an engine that is not a part gets no entry", () => {
  const rows = requiresFor([cand("sage-llama", "llama-server")], () => undefined, () => []);
  expect(rows).toEqual([]);
});

test("a companion that is itself a candidate of the category is skipped", () => {
  const parts = new Map<string, RequiresPart>([["sage-draft", part("Sage draft")]]);
  const companions = new Map<string, string[]>([["marlow", ["sage-draft"]]]);
  const rows = requiresFor([cand("marlow", null), cand("sage-draft", null)], (id) => parts.get(id), (id) => companions.get(id) ?? []);
  expect(rows).toEqual([]);
});

test("a draft companion that is a part appears as kind draft naming the candidate", () => {
  const parts = new Map<string, RequiresPart>([["nova-draft", part("Nova draft")]]);
  const companions = new Map<string, string[]>([["marlow", ["nova-draft"]], ["nova-draft", []]]);
  const rows = requiresFor([cand("marlow", null)], (id) => parts.get(id), (id) => companions.get(id) ?? []);
  expect(rows.length).toBe(1);
  expect(rows[0]).toMatchObject({ id: "nova-draft", kind: "draft", label: "Nova draft", needed_by: ["marlow"] });
});

test("entries sort engine first, then by id, with no duplicates", () => {
  const parts = new Map<string, RequiresPart>([["splash", part("Splash")], ["atlas-draft", part("Atlas draft")], ["zenith-draft", part("Zenith draft")]]);
  const companions = new Map<string, string[]>([["marlow", ["zenith-draft", "atlas-draft", "splash"]]]);
  const rows = requiresFor([cand("marlow", "splash")], (id) => parts.get(id), (id) => companions.get(id) ?? []);
  expect(rows.map((row) => `${row.kind}:${row.id}`)).toEqual(["engine:splash", "draft:atlas-draft", "draft:zenith-draft"]);
});

beforeEach(() => {
  __resetSettingsForTests(); __resetChoicesForTests(); __resetPartChoicesForTests();
  __setChoicesDepsForTests({
    probe: async () => hw(128),
    parts: async (hardware) => (await listParts({ audience: "adult" }, hardware)).parts,
  });
});
afterEach(() => { __setChoicesDepsForTests(null); __resetSettingsForTests(); __resetChoicesForTests(); __resetPartChoicesForTests(); });

test("readChoices gives every category a requires array in the declared shape", async () => {
  const view = await readChoices();
  expect(view.categories.length > 0).toBe(true);
  for (const category of view.categories) {
    expect(CategorySchema.safeParse(category).success).toBe(true);
    expect(Array.isArray(category.requires)).toBe(true);
    const ids = new Set(category.candidates.map((candidate) => candidate.id));
    for (const row of category.requires) {
      expect(["engine", "draft"]).toContain(row.kind);
      expect(row.needed_by.every((id) => ids.has(id))).toBe(true);
    }
    const keys = category.requires.map((row) => `${row.kind}:${row.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  }
});
