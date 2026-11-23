// The Helper's get_models read is built from the same `GET /stack/v1/choices` answer the AI and models page renders, so the two name the same
// models in the same words (a model's plain name, its version, what is installed, what each level uses). The hardware probe and the parts
// list are the choices tests' own injections; the choices read itself is the real one.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { __setChoicesDepsForTests, readChoices } from "@/lib/choices";
import { __resetChoicesForTests } from "@/lib/choicesStore";
import { __resetPartChoicesForTests } from "@/lib/partChoices";
import { readModels } from "@/lib/helperReads";
import type { RouteCall } from "@/lib/helperTools";
import type { HardwareInfo } from "@/lib/hardware";
import { __resetSettingsForTests } from "@/settings";

const hw = (gb: number): HardwareInfo => ({ platform: "darwin", arch: "arm64", totalRamGb: gb, cpuCount: 8, isAppleSilicon: true, unifiedMemoryGb: gb, cudaDevices: [], freeDiskBytes: 1e12, osVersion: "test" });
const ROLES = [
  { id: "chat", label: "Chat", enabled: true, priority: 100, state: { state: "ready" }, model: { id: "qwen3-8b-instruct-q4-k-m", sizeBytes: 5_000_000_000 } },
  { id: "judge", label: "Judge", enabled: true, priority: 100, state: { state: "ready" }, model: null },
  { id: "coding", label: "Coding", enabled: true, priority: 100, state: { state: "installed" }, model: null },
  { id: "stt", label: "Voice in", enabled: true, priority: 100, state: { state: "ready" }, model: null },
];
let failChoices = false;
const route: RouteCall = async (_method, path) => {
  if (path === "/stack/v1/roles") return { status: 200, json: { roles: ROLES } };
  if (path === "/stack/v1/choices") return failChoices ? { status: 500, json: {} } : { status: 200, json: await readChoices() };
  return { status: 200, json: { ok: true } };
};

beforeEach(() => {
  failChoices = false;
  __resetSettingsForTests(); __resetChoicesForTests(); __resetPartChoicesForTests();
  __setChoicesDepsForTests({
    probe: async () => hw(128),
    parts: async (hardware) => { const { listParts } = await import("@/lib/partsList"); return (await listParts({ audience: "adult" }, hardware)).parts; },
  });
});
afterEach(() => { __setChoicesDepsForTests(null); __resetSettingsForTests(); __resetChoicesForTests(); __resetPartChoicesForTests(); });

test("every chat model the page lists is in the Helper's answer under its plain name, with its version and state", async () => {
  const view = await readChoices();
  const chat = view.categories.find((c) => c.id === "chat")!;
  const out = await readModels(route, { role: "chat" });
  expect(out.ok).toBe(true);
  for (const candidate of chat.candidates) {
    expect(out.text).toContain(`${candidate.label} (${candidate.id})`);
    if (candidate.version) expect(out.text).toContain(`version ${candidate.version}`);
  }
  expect(out.text).toContain("not installed");
  expect(out.text).toContain("Standard");
  expect(out.text).toMatch(/CHOSEN for (Reduced|Standard|Boost|Max)/);
});

test("a level question names only that level, and a feature without levels says so in the Stack's own sentence", async () => {
  const max = await readModels(route, { role: "chat", tier: "max" });
  expect(max.text).toContain("- Max (");
  expect(max.text).not.toContain("- Standard (");
  const coding = await readModels(route, { role: "stt", tier: "max" });
  expect(coding.ok).toBe(true);
  expect(coding.lead).toContain("has no Max tier");
});

test("judge shares the chat models, and a failed choices read is a plain could-not-read", async () => {
  const judge = await readModels(route, { role: "judge" });
  expect(judge.text).toContain("Qwen3");
  failChoices = true;
  const failed = await readModels(route, { role: "chat" });
  expect(failed.ok).toBe(false);
  expect(failed.text).toBe("Could not read the models.");
});
