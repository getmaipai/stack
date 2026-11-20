import { afterEach, expect, test } from "bun:test";
import { __sampleDiskForTests, __setDiskReaderForTests, diskAdmission, latestDisk, lowDiskRefusal } from "@/lib/diskState";
import { app } from "@/app";

const refusal = "There is not enough room left on this computer for that. Free up space in Settings, then try again.";
afterEach(() => __setDiskReaderForTests(null));

test("disk sampling tracks hysteretic levels and critical admission without reading the real disk", () => {
  let free = 9_000_000_000;
  __setDiskReaderForTests(() => ({ free, total: 100_000_000_000, device: 1 }));
  __sampleDiskForTests();
  expect(latestDisk().level).toBe("critical");
  expect(lowDiskRefusal()).toBe(refusal);
  expect(refusal).not.toMatch(/[0-9]|GB/i);
  free = 10_500_000_000;
  __sampleDiskForTests();
  expect(latestDisk().level).toBe("critical");
  free = 12_000_000_000;
  __sampleDiskForTests();
  expect(latestDisk().level).toBe("warn");
  expect(diskAdmission(3_000_000_000).ok).toBe(false);
  free = 20_000_000_000;
  __sampleDiskForTests();
  expect(diskAdmission(1_000_000_000)).toEqual({ ok: true });
});

test("GET /stack/v1/disk includes volumes and selected-model missing list", async () => {
  __setDiskReaderForTests(() => ({ free: 50_000_000_000, total: 100_000_000_000, device: 9 }));
  const response = await app.request("/stack/v1/disk");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ level: expect.any(String), volumes: [expect.objectContaining({ path: expect.any(String), free_bytes: expect.any(Number), total_bytes: expect.any(Number), warn_bytes: expect.any(Number), critical_bytes: expect.any(Number) })], missing: expect.any(Array) });
});
