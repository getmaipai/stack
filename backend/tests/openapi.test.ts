import { expect, test } from "bun:test";
import { app } from "@/app";

test("the OpenAPI document includes the health route", async () => {
  const response = await app.request("/api/openapi.json");
  expect(response.status).toBe(200);
  const document = await response.json() as { paths?: Record<string, unknown> };
  expect(document.paths?.["/healthz"]).toBeDefined();
});
