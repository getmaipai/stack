import { expect, test } from "bun:test";
import { app } from "@/app";
import { ErrorSchema, errorResponses } from "@/lib/openapi";

test("the OpenAPI document includes the health route", async () => {
  const response = await app.request("/api/openapi.json");
  expect(response.status).toBe(200);
  const document = await response.json() as { paths?: Record<string, unknown> };
  expect(document.paths?.["/healthz"]).toBeDefined();
});

test("errorResponses maps a status to its description and ErrorSchema", () => {
  const responses = errorResponses({ 404: "Not found" });
  const entry = responses[404] as { description: string; content: { "application/json": { schema: typeof ErrorSchema } } };
  expect(entry.description).toBe("Not found");
  expect(entry.content["application/json"].schema).toBe(ErrorSchema);
});

test("ErrorSchema accepts an error string and rejects an empty object", () => {
  expect(ErrorSchema.parse({ error: "x" })).toEqual({ error: "x" });
  expect(ErrorSchema.safeParse({}).success).toBe(false);
});
