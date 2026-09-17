import { expect, test } from "bun:test";
import { ROLE_IDS, ROLES } from "@/roles";
import { app } from "@/app";

test("every RoleId has a declaration", () => {
  for (const id of ROLE_IDS) expect(ROLES[id]).toBeDefined();
});

test("every declared endpoint exists in the OpenAPI document", async () => {
  const document = await (await app.request("/api/openapi.json")).json() as { paths: Record<string, unknown> };
  for (const id of ROLE_IDS) {
    for (const endpoint of ROLES[id].endpoints) expect(document.paths[endpoint]).toBeDefined();
  }
});

test("the wire declaration covers the four current request kinds", () => {
  const wires = new Set(ROLE_IDS.map((id) => ROLES[id].wire));
  for (const wire of ["chat", "embeddings", "transcription", "speech"] as const) expect(wires.has(wire)).toBe(true);
});
