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

test("GET /stack/v1/hardware proposal is null or one of the tiers, and labels stay plain", async () => {
  const response = await app.request("/stack/v1/hardware");
  expect(response.status).toBe(200);
  const body = await response.json() as {
    proposed: { id: string } | null;
    tiers: { id: string; label: string }[];
  };
  if (body.proposed !== null) {
    expect(body.tiers.some((tier) => tier.id === body.proposed?.id)).toBe(true);
  }
  for (const tier of body.tiers) {
    expect(tier.label.endsWith(".")).toBe(true);
    expect(tier.label).not.toMatch(/\b(stt|tts|embed)\b/);
  }
});
