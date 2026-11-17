import { beforeEach, describe, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetHealthForTests, raise } from "@/lib/health";
import { __resetJobsForTests, createJob, updateJob } from "@/lib/jobs";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly } from "@/lib/governor";
import { __resetMemoryStateForTests, setMemoryLevel } from "@/lib/memoryState";
import { __resetStackStatusForTests, __setStatusHardwareForTests, stackStatus } from "@/lib/stackStatus";
import { __setUpdateInProgressForTests, updateInProgress, swapEngine } from "@/updates/engines";
import { StackStatus } from "@maipai/spec/stack/ts/stack-status.js";
import type { HardwareInfo } from "@/lib/hardware";

const GB = 1_000_000_000;
const hw = (over: Partial<HardwareInfo> = {}): HardwareInfo => ({ platform: "darwin", arch: "arm64", totalRamGb: 128, cpuCount: 16, isAppleSilicon: true, unifiedMemoryGb: 128, cudaDevices: [], freeDiskBytes: 1500 * GB, totalDiskBytes: 2000 * GB, osVersion: "test", ...over });

beforeEach(() => {
  __resetHealthForTests(); __resetJobsForTests(); __resetGovernorForTests();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 80 * GB, tier: "p128" });
  __resetMemoryStateForTests(); __resetStackStatusForTests(); __setStatusHardwareForTests(null); __setUpdateInProgressForTests(null);
});

describe("STACK-STATUS-01", () => {
  test("composes a clean status and serves the spec shape", async () => {
    const status = await stackStatus(hw());
    expect(status.health).toBe("ok"); expect(status.problems).toEqual([]);
    expect(status.busy).toEqual({ running: 0, waiting: 0 }); expect(status.memory.total_bytes).toBe(128 * GB); expect(status.memory.pressure).toBe("normal");
    __setStatusHardwareForTests(hw());
    const response = await app.request("/stack/v1/status"); const json = await response.json();
    expect(response.status).toBe(200); expect(StackStatus.safeParse(json).success).toBe(true);
  });

  test("reports a stopped chat engine as one actionable problem", async () => {
    raise({ code: "engine.crashed.chat", severity: "error", title: "The chat engine crashed", text: "It ran out of memory.", cause: "out of memory", fix: { label: "Restart engine", action: "restart_engine" } });
    const result = await stackStatus(hw());
    expect(result.problems).toHaveLength(1); expect(result.problems[0]).toMatchObject({ code: "engine.crashed.chat", plain: "It ran out of memory.", fix: "Restart engine" });
    expect(Date.parse(result.problems[0]!.since)).not.toBeNaN(); expect(result.health).toBe("down");
  });

  test("reports and clears the computed low disk problem", async () => {
    const low = await stackStatus(hw({ freeDiskBytes: 1_000_000_000 }));
    expect(low.problems).toHaveLength(1); expect(low.problems[0]).toMatchObject({ code: "disk-full", fix: expect.stringContaining("Free space") });
    expect(low.problems[0]!.plain).toContain("1 GB"); expect(low.health).toBe("degraded");
    expect((await stackStatus(hw())).problems).toEqual([]);
  });

  test("maps component failures and leaves warnings healthy", async () => {
    raise({ code: "component-install-failed.z-image-turbo", severity: "warning", title: "Z-Image-Turbo could not be installed", text: "The download or setup of Z-Image-Turbo did not finish.", cause: "network", fix: { label: "Try again", action: "retry_download" } });
    const result = await stackStatus(hw()); expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ part_id: "z-image-turbo", fix: "Try again" }); expect(result.health).toBe("ok");
  });

  test("update state wins over a stopped chat and clears after a failed swap", async () => {
    raise({ code: "engine.crashed.chat", severity: "error", title: "The chat engine crashed", text: "It ran out of memory.", cause: "out of memory" });
    __setUpdateInProgressForTests(true); expect((await stackStatus(hw())).health).toBe("updating");
    __setUpdateInProgressForTests(null); expect((await stackStatus(hw())).health).toBe("down");
    await expect(swapEngine("llama-server", "missing-status-test-tag")).rejects.toThrow("Engine tag is not installed");
    expect(updateInProgress()).toBe(false);
  });

  test("maps jobs and counts governor queue work", async () => {
    const running = createJob({ kind: "image_generation", input: { model: "z-image-turbo" } }); updateJob(running.id, { state: "running", percent: 40 });
    createJob({ kind: "image_generation", input: { model: "z-image-turbo" }, state: "queued" });
    createJob({ kind: "image_generation", input: { model: "not-a-part" }, state: "queued" });
    const result = await stackStatus(hw());
    expect(result.busy.running).toBe(1); expect(result.busy.waiting).toBe(2);
    expect(result.jobs.find((job) => job.id === running.id)).toMatchObject({ part_id: "z-image-turbo", state: "running", percent: 40 });
    expect(result.jobs.find((job) => job.part_id === null)).toBeDefined();
  });

  test("critical memory pressure degrades health", async () => {
    setMemoryLevel("critical"); const result = await stackStatus(hw());
    expect(result.memory.pressure).toBe("critical"); expect(result.health).toBe("degraded");
  });

  test("uses a standing fix when a health item has none", async () => {
    raise({ code: "managed-host-offline.tts", severity: "warning", title: "Voice host offline", text: "The voice host is not answering.", cause: "offline" });
    const result = await stackStatus(hw()); expect(result.problems[0]!.fix).toBe("The Stack is watching this; nothing to press yet.");
    expect(StackStatus.safeParse(result).success).toBe(true);
  });
});
