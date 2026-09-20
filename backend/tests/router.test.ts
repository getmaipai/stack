import { afterEach, beforeEach, expect, test } from "bun:test";
import { clearModelsForTests, upsertModel } from "@/lib/modelStore";
import { noEngineResponse, resolveRole, resolveRoleState, UnknownRoleError, UnverifiedModelError } from "@/lib/router";
import { getProcess, resetSupervisorForTests, scriptedProcess, setSupervisorFactoryForTests } from "@/lib/supervisor";
import { READY_TTL_MS } from "@/roles";

beforeEach(() => { clearModelsForTests(); setSupervisorFactoryForTests(async (role) => scriptedProcess(role)); });
afterEach(() => { setSupervisorFactoryForTests(null); resetSupervisorForTests(); clearModelsForTests(); });

test("a role id resolves to itself; an installed, verified model id resolves to its first role", () => {
  expect(resolveRole("chat")).toEqual({ role: "chat", modelId: null });
  upsertModel({ id: "m-verified", roles: ["embed"], source: "catalog", provenance: {}, revision: "r", sha256: "a".repeat(64), licence: "MIT", verifiedAt: new Date().toISOString() });
  expect(resolveRole("m-verified")).toEqual({ role: "embed", modelId: "m-verified" });
});

test("an unknown id is a 400 with the role list; an unverified model is a 409 naming what is missing", () => {
  expect(() => resolveRole("nope")).toThrow(UnknownRoleError);
  upsertModel({ id: "m-unverified", roles: ["chat"], source: "huggingface", provenance: {}, revision: "r", sha256: null, licence: null });
  try { resolveRole("m-unverified"); throw new Error("expected a throw"); }
  catch (error) { expect(error).toBeInstanceOf(UnverifiedModelError); expect((error as UnverifiedModelError).missing).toEqual(["sha256", "licence", "verifiedAt"]); }
});

test("ready is time-bound: a stale last request degrades to loaded", async () => {
  await getProcess("chat");
  expect(resolveRoleState("chat").state).toBe("ready");
  const realNow = Date.now;
  Date.now = () => realNow() + READY_TTL_MS + 1;
  try { expect(resolveRoleState("chat").state).toBe("loaded"); } finally { Date.now = realNow; }
});

test("no engine is never a 404: the 503 names the role, its state and the reason, with none identity", () => {
  const response = noEngineResponse("tts", "No tts engine is installed on this machine.");
  expect(response.status).toBe(503);
  expect(response.body).toMatchObject({ role: "tts", state: "notInstalled", offline_reason: "No tts engine is installed on this machine." });
  expect(response.headers["x-maipai-engine"]).toBe("none");
});
