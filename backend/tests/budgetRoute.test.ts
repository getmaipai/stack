import { expect, test } from "bun:test";
import { app } from "@/app";
import { testClientHeaders } from "./authTest";

test("GET /stack/v1/budget returns governor status for a client", async () => {
  const response = await app.request("/stack/v1/budget", { headers: testClientHeaders });
  expect(response.status).toBe(200);
  const body = await response.json() as { capBytes: number; freeMemoryBytes: number; pressure: boolean; loaded: unknown[]; queue: unknown[] };
  expect(body.capBytes).toBeGreaterThan(0);
  expect(body.freeMemoryBytes).toBeGreaterThanOrEqual(0);
  expect(typeof body.pressure).toBe("boolean");
  expect(Array.isArray(body.loaded)).toBe(true);
  expect(Array.isArray(body.queue)).toBe(true);
});
