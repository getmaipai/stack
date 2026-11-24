// The readiness steps each category carries on the choices read (docs/dev/choices.md): installed, loaded, ready, judged from the role's own state.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { __setChoicesDepsForTests, readChoices } from "@/lib/choices";
import { stepsFromState, type Step } from "@/lib/choiceRequires";
import { CategorySchema } from "@/lib/choicesSchema";
import { __resetChoicesForTests } from "@/lib/choicesStore";
import { __resetPartChoicesForTests } from "@/lib/partChoices";
import { listParts } from "@/lib/partsList";
import { __resetSettingsForTests } from "@/settings";
import type { HardwareInfo } from "@/lib/hardware";

const hw = (gb: number): HardwareInfo => ({ platform: "darwin", arch: "arm64", totalRamGb: gb, cpuCount: 8, isAppleSilicon: true, unifiedMemoryGb: gb, cudaDevices: [], freeDiskBytes: 1e12, osVersion: "test" });

type Status = Step["status"];

const check = (state: Parameters<typeof stepsFromState>[0], statuses: Status[], reason: string | null = null): void => {
  const steps = stepsFromState(state, reason);
  expect(steps.map((step) => step.id)).toEqual(["installed", "loaded", "ready"]);
  expect(steps.map((step) => step.label)).toEqual(["Installed", "Loaded", "Ready"]);
  expect(steps.map((step) => step.status)).toEqual(statuses);
  // Only the failed step may carry a reason; every other step's reason is null.
  expect(steps.map((step) => step.reason)).toEqual(steps.map((step) => (step.status === "failed" ? reason : null)));
};

test("stepsFromState maps every role state to the agreed step statuses", () => {
  check("notInstalled", ["current", "waiting", "waiting"]);
  check("installed", ["done", "current", "waiting"]);
  check("loaded", ["done", "done", "current"]);
  check("ready", ["done", "done", "done"]);
  check("offline", ["done", "failed", "waiting"], "The engine exited unexpectedly.");
});

beforeEach(() => {
  __resetSettingsForTests(); __resetChoicesForTests(); __resetPartChoicesForTests();
  __setChoicesDepsForTests({
    probe: async () => hw(128),
    parts: async (hardware) => (await listParts({ audience: "adult" }, hardware)).parts,
  });
});
afterEach(() => { __setChoicesDepsForTests(null); __resetSettingsForTests(); __resetChoicesForTests(); __resetPartChoicesForTests(); });

test("readChoices gives every category a steps array: empty without a role, three steps with one", async () => {
  const view = await readChoices();
  expect(view.categories.length > 0).toBe(true);
  for (const category of view.categories) {
    expect(CategorySchema.safeParse(category).success).toBe(true);
    expect([0, 3]).toContain(category.steps.length);
    expect(category.steps.length).toBe(category.role ? 3 : 0);
    expect(category.steps.every((step) => step.reason === null || step.status === "failed")).toBe(true);
  }
});
