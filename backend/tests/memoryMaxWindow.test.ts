// TIER-STATUS-01: GET /stack/v1/memory reports the governor's own Max window, so Home reads the Stack's truth instead of a flag of its own.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit, release, type GovernorHandle } from "@/lib/governor";

const GB = 1_073_741_824;
beforeEach(() => { __resetGovernorForTests(); __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 120 * GB, tier: "p128" }); });
afterEach(() => __resetGovernorForTests());
const window = async () => (await (await app.request("/stack/v1/memory")).json() as { max_window: { state: string; owner: string | null; since: string | null } }).max_window;

test("max_window is none with no Max job, open with the owner while one holds the computer, and none again after", async () => {
  expect(await window()).toEqual({ state: "none", owner: null, since: null });
  const handle = await admit({ id: "max-job", kind: "generator", class: "burst", role: "video", requestedBytes: 10 * GB, tier: "max" }) as GovernorHandle;
  const open = await window();
  expect(open.state).toBe("open");
  expect(open.owner).toBe("max-job");
  expect(Number.isNaN(Date.parse(open.since!))).toBe(false);
  release(handle);
  expect(await window()).toEqual({ state: "none", owner: null, since: null });
});
