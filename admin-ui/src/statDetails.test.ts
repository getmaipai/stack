import { describe, expect, test } from "bun:test";
import { driveDetails, modelsHint, requestRate } from "./statDetails";
import type { StackDrive, StackDriveFeature } from "@maipai/ui/src/stack/StackClient";

const disks: StackDrive[] = [
  { id: "main", label: "Main", root_path: "/main", connected: true, free_bytes: 40, total_bytes: 100, removable: false },
  { id: "archive", label: "Archive", root_path: "/archive", connected: true, free_bytes: 80, total_bytes: 100, removable: true },
];
const features: StackDriveFeature[] = [
  { feature_id: "chat", label: "Chat", bytes: 30, drive_ids: ["main"], drives: [{ id: "main", label: "Main", connected: true }] },
  { feature_id: "image", label: "Image", bytes: 20, drive_ids: ["main", "archive"], drives: [{ id: "main", label: "Main", connected: true }, { id: "archive", label: "Archive", connected: true }] },
];

describe("stat detail data", () => {
  test("builds drive and feature rows with split sizes", () => {
    const rows = driveDetails(disks, features);
    expect(rows.map((r) => r.usedBytes)).toEqual([60, 20]);
    expect(rows[0]?.features.map((r) => r.bytes)).toEqual([30, 10]);
    expect(rows[1]?.features.map((r) => r.bytes)).toEqual([10]);
  });
  test("says where models live and sums free space, count and size", () => {
    const hint = modelsHint(disks, features)!;
    expect(hint).toContain("On Main and Archive.");
    expect(hint).toContain("40 B free");
    expect(hint).toContain("80 B free");
    expect(hint).toContain("2 models");
    expect(hint).toContain("50 B total");
  });
  test("handles empty and failed disk reads", () => {
    expect(modelsHint([], [])).toContain("No drives are listed");
    expect(modelsHint(null, features)).toBeNull();
  });
  test("summarizes recent queue rate", () => {
    expect(requestRate([{ t: 0, queue: 0 }, { t: 30, queue: 2 }, { t: 60, queue: 1 }])).toContain("Peak queue 2; average 1.0");
    expect(requestRate([{ t: 0, queue: 0 }])).toBeNull();
  });
});
