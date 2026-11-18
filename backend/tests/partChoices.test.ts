import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { PART_DEFS } from "@/lib/partDefs";
import { __resetPartChoicesForTests, __setRequiresForTests, choicesRefusal, readPartChoices, type Choices } from "@/lib/partChoices";
import { stackParts } from "@/lib/parts";
import { listParts } from "@/lib/partsList";
import { StackPartList } from "@maipai/spec/stack/ts/stack-part-list.js";

beforeEach(() => { __resetPartChoicesForTests(); __setRequiresForTests(null); });
afterEach(() => { __resetPartChoicesForTests(); __setRequiresForTests(null); });

test("defaults list every eligible part enabled with shipped priorities and engine rows", async () => {
  const result = await listParts({ audience: "adult" });
  const nonEngines = result.parts.filter((row) => row.kind !== "engine");
  expect(nonEngines.every((row) => row.enabled && row.priority === PART_DEFS.find((def) => def.id === row.id)?.priority)).toBe(true);
  expect(new Set(result.parts.map((row) => row.id))).toEqual(new Set(PART_DEFS.filter((def) => !def.minorOnly).map((def) => def.id)));
  const engines = (await listParts({ audience: "adult", kind: "engine" })).parts;
  expect(engines.length).toBeGreaterThan(0);
  expect(engines.every((row) => !row.can_install && !row.can_uninstall && Object.values(row.fits).slice(0, 3).every(Boolean))).toBe(true);
  expect(StackPartList.safeParse(result).success).toBe(true);
});

test("pushed order and off values are stored and applied", async () => {
  const response = await app.request("/stack/v1/parts/choices", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ pictures: { order: ["z-image-turbo", "flux3-image-klein"], off: ["ernie-image-turbo"] } }) });
  expect(response.status).toBe(200);
  const body = await response.json() as { parts: Array<{ id: string; priority: number; enabled: boolean }> };
  expect(body.parts.find((row) => row.id === "z-image-turbo")?.priority).toBe(1);
  expect(body.parts.find((row) => row.id === "flux3-image-klein")?.priority).toBe(2);
  expect(body.parts.find((row) => row.id === "minimax-h3-image")?.priority).toBe(4);
  expect(body.parts.find((row) => row.id === "ernie-image-turbo")?.enabled).toBe(false);
  expect((await listParts({ audience: "adult", category: "pictures" })).parts.map((row) => row.id).slice(0, 3)).toEqual(["z-image-turbo", "flux3-image-klein", "minimax-h3-image"]);
  expect((await app.request("/stack/v1/parts?audience=adult")).status).toBe(200);
  expect(readPartChoices().pictures?.order).toEqual(["z-image-turbo", "flux3-image-klein"]);
  const skipped = await app.request("/stack/v1/parts/choices", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ pictures: { order: ["qwen3-8b-instruct-q4-k-m", "no-such-part"], off: [] } }) });
  expect(skipped.status).toBe(200);
});

test("engines cannot be turned off and refusal preserves prior choices", async () => {
  const initial: Choices = { pictures: { order: ["z-image-turbo"], off: [] } };
  const put = (choices: Choices) => app.request("/stack/v1/parts/choices", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(choices) });
  expect((await put(initial)).status).toBe(200);
  expect(await (await put({ engines: { order: [], off: ["llama-server"] } })).json()).toMatchObject({ code: "engine_has_no_switch" });
  expect(readPartChoices()).toEqual(initial);
});

test("runner engines are required by their model parts and engine operations are refused", async () => {
  const list = (await listParts({ audience: "adult" })).parts;
  expect(list.find((row) => row.id === "llama-server")?.required_by).toContain("qwen3-8b-instruct-q4-k-m");
  expect(stackParts().find((part) => part.id === "qwen3-8b-instruct-q4-k-m")?.requires).toEqual(["llama-server"]);
  expect(await (await app.request("/stack/v1/parts/llama-server", { method: "DELETE" })).json()).toMatchObject({ code: "engine_part", error: expect.stringContaining("llama.cpp") });
  expect(await (await app.request("/stack/v1/parts/llama-server/install", { method: "POST" })).json()).toMatchObject({ code: "engine_part" });
});

test("required dependencies refuse off unless dependents are also off", () => {
  __setRequiresForTests(new Map([["z-image-turbo", ["flux3-image-klein"]]]));
  const blocked: Choices = { pictures: { order: [], off: ["flux3-image-klein"] } };
  expect(choicesRefusal(blocked)).toMatchObject({ status: 409, code: "required_by", error: expect.stringContaining("Z-Image-Turbo") });
  expect(choicesRefusal({ pictures: { order: [], off: ["flux3-image-klein", "z-image-turbo"] } })).toBeNull();
});
