import { expect, test } from "bun:test";
import { ROLE_IDS, ROLES } from "@/roles";
import { app } from "@/app";

test("every RoleId has a declaration", () => {
  for (const id of ROLE_IDS) expect(ROLES[id]).toBeDefined();
});

test("every role has a person-readable label", () => {
  for (const id of ROLE_IDS) expect(ROLES[id].label.trim()).not.toBe("");
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

// CODE-STACK-01 S1: coding is its own on-demand role, not a second name for chat.
test("coding is an on-demand role with its own model: it no longer shares chat's", () => {
  expect(ROLES.coding.residency).toBe("jit");
  expect((ROLES.coding as { sharesModelWith?: string }).sharesModelWith).toBeUndefined();
  expect(ROLES.coding.wire).toBe("chat");
  expect(ROLES.coding.endpoints).toEqual(["/v1/chat/completions"]);
  expect(ROLES.chat.residency).toBe("resident");
  // The roles that still share chat's model are untouched.
  for (const id of ["judge", "router"] as const) expect((ROLES[id] as { sharesModelWith?: string }).sharesModelWith).toBe("chat");
});
