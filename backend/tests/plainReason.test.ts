// Home never shows raw engine text, so each role carries `plain_reason`: set
// only to a classified plain sentence, null for every other reason.
import { expect, test } from "bun:test";
import { METAL_COMPILER_SENTENCE, describeStartFailure, plainReasonOf } from "@/lib/crashClassifier";
import { ROLE_IDS } from "@/roles";
import { app } from "@/app";

test("the Metal compiler sentence and the out-of-memory sentence are plain reasons", () => {
  const metal = describeStartFailure(1, "ggml_metal_library_compile_all: Unable to reach MTLCompilerService");
  expect(plainReasonOf(metal)).toBe(METAL_COMPILER_SENTENCE);
  const oom = describeStartFailure(1, "failed to allocate buffer of size 9000000000");
  expect(plainReasonOf(oom)).toBe(oom);
  expect(plainReasonOf(oom)).toContain("ran out of memory");
});

test("raw engine text and unknown reasons are not plain reasons", () => {
  expect(plainReasonOf("Engine exited before becoming healthy (code 1): failed to create context with model")).toBeNull();
  expect(plainReasonOf("The spawned engine exited unexpectedly.")).toBeNull();
  expect(plainReasonOf(null)).toBeNull();
  expect(plainReasonOf("")).toBeNull();
});

test("every role in /stack/v1/roles carries plain_reason, null when nothing is classified", async () => {
  const body = await (await app.request("/stack/v1/roles")).json() as { roles: Array<{ id: string; plain_reason?: string | null }> };
  expect(body.roles.map((role) => role.id)).toEqual([...ROLE_IDS]);
  for (const role of body.roles) expect(role.plain_reason).toBeNull();
});
