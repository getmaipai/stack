// STACK-06e: the governor's working margin follows the machine's tier.
// The daemon sets the tier from the hardware profile at start and every
// governor watch a process gets carries it, so a p128 machine keeps
// p128's 20 GB back, not the p16 default's 4 GB.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit, getGovernorStatus, GovernorRules } from "@/lib/governor";
import { __resetHealthForTests } from "@/lib/health";
import { __setMemoryReaderForTests } from "@/lib/memory";
import { scriptedMemoryReader } from "@/lib/memory/scripted";
import { currentMachineTier, resetSupervisorForTests, setMachineTier, watchProcessMemory } from "@/lib/supervisor";
import { GOVERNOR_MEMORY_DEFAULT } from "./governorMemoryDefault";

const GB = 1_073_741_824;
// The governor's watch re-reads memory as it starts, so the reading it
// finds is the machine this test describes: 128 GB with 30 GB free.
const machine = { totalBytes: 128 * GB, freeBytes: 30 * GB, availablePercent: 23, pressure: "normal" as const, degraded: false };
beforeEach(() => { __resetHealthForTests(); __setMemoryReaderForTests(scriptedMemoryReader(Array.from({ length: 50 }, () => machine))); __resetGovernorForTests(); });
afterEach(() => { setMachineTier(null); resetSupervisorForTests(); __setMemoryReaderForTests(scriptedMemoryReader([GOVERNOR_MEMORY_DEFAULT])); __resetGovernorForTests(); });

test("a p128 machine keeps p128's margin: a load that fits under the p16 default is queued under p128", async () => {
  expect(GovernorRules.tiers.p128.workingMarginBytes).toBe(20 * GB);
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 30 * GB });
  // Before any watch carries a tier, the default p16 margin admits 20 GB of a 30 GB free.
  const underDefault = await admit({ id: "chat", kind: "resident", requestedBytes: 20 * GB });
  expect("id" in underDefault).toBe(true);
  __resetGovernorForTests();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 30 * GB });
  setMachineTier("p128");
  expect(currentMachineTier()).toBe("p128");
  const stop = watchProcessMemory("chat", process.pid);
  try {
    const underP128 = await admit({ id: "chat", kind: "resident", requestedBytes: 20 * GB });
    expect(underP128).toMatchObject({ queued: true });
    expect(getGovernorStatus().queue.map((item) => item.id)).toEqual(["chat"]);
  } finally {
    stop();
  }
});

test("a machine whose profile is unknown keeps the p16 margin, the smallest", async () => {
  setMachineTier(null);
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 30 * GB });
  const stop = watchProcessMemory("chat", process.pid);
  try {
    expect("id" in await admit({ id: "chat", kind: "resident", requestedBytes: 20 * GB })).toBe(true);
  } finally {
    stop();
  }
});

test("the tier is in force from the daemon's start, before any process is spawned", async () => {
  const { __setGovernorTuningForTestsOnly: tune } = await import("@/lib/governor");
  setMachineTier("p128");
  const { startGovernor } = await import("@/lib/governor");
  const stop = startGovernor({ pid: process.pid, tier: currentMachineTier() });
  try {
    tune({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 30 * GB });
    expect(await admit({ id: "chat", kind: "resident", requestedBytes: 20 * GB })).toMatchObject({ queued: true });
  } finally {
    stop();
  }
});
