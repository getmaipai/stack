import { expect, test } from "bun:test";
import { app } from "@/app";

test("GET /stack/v1/hardware returns hardware, proposal, and tiers", async () => {
  const response = await app.request("/stack/v1/hardware");
  expect(response.status).toBe(200);
  const body = await response.json() as { hardware: { freeDiskBytes: number; osVersion: string }; proposed: unknown; tiers: unknown[] };
  expect(body.hardware.freeDiskBytes).toBeGreaterThan(0);
  expect(body.hardware.osVersion).not.toBe("");
  expect(body.tiers).toHaveLength(4);
});
