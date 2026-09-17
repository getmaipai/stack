import { describe, expect, test } from "bun:test";
import { app } from "@/app";

describe("GET /healthz", () => {
  test("returns a healthy semver response", async () => {
    const response = await app.request("/healthz");
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; version: string; uptimeSeconds: number };
    expect(body.ok).toBe(true);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});
