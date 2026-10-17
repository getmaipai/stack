// VISION-03f: a Muse record installed before its projector was pinned
// (the Studio, 2026-10-17) has no picture input, and the install plan
// skips an installed model, so pulling the projector alone left chat text
// only. The pin's declarations are copied onto the installed record of
// the same bytes, and a chat process that started text-only restarts when
// the projector arrives.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { __resetGovernorForTests } from "@/lib/governor";
import { __resetHealthForTests } from "@/lib/health";
import { STACK_CHAT_MUSE_30B_PROJECTOR, STACK_CHAT_MUSE_30B_XL_MODEL, STACK_MODELS } from "@/lib/modelCatalog";
import { clearModelsForTests, getModel, reconcilePinDeclarations, upsertModel, registerCatalogModel } from "@/lib/modelStore";
import { getProcess, resetSupervisorForTests, restartForNewProjector, scriptedProcess, setSupervisorFactoryForTests } from "@/lib/supervisor";

const verifiedAt = "2026-10-17T00:00:00.000Z";

/** The Studio's record as installed before VISION-03a: no imageInput, no imageMaxTokens. */
function installStaleMuse() {
  const fresh = registerCatalogModel(STACK_CHAT_MUSE_30B_XL_MODEL);
  const { imageInput: _drop, ...rest } = fresh.engineRequirements as Record<string, unknown>;
  return upsertModel({ ...fresh, engineRequirements: { ...rest, launch: { chatTemplateKwargs: { reasoning_strength: "low" } } }, verifiedAt, modelPath: join("/tmp", "muse.gguf") });
}
function installProjector() {
  return upsertModel({ ...registerCatalogModel(STACK_CHAT_MUSE_30B_PROJECTOR), verifiedAt, modelPath: join("/tmp", "muse-mmproj.gguf") });
}

beforeEach(() => { clearModelsForTests(); __resetHealthForTests(); __resetGovernorForTests(); });
afterEach(() => { setSupervisorFactoryForTests(null); resetSupervisorForTests(); clearModelsForTests(); __resetGovernorForTests(); });

test("an installed Muse record without picture input gets the pin's declarations, once", () => {
  installStaleMuse();
  expect(getModel(STACK_CHAT_MUSE_30B_XL_MODEL.id)!.engineRequirements.imageInput).toBeUndefined();
  expect(reconcilePinDeclarations(STACK_MODELS)).toEqual([STACK_CHAT_MUSE_30B_XL_MODEL.id]);
  const record = getModel(STACK_CHAT_MUSE_30B_XL_MODEL.id)!;
  expect(record.engineRequirements.imageInput).toEqual({ projector: STACK_CHAT_MUSE_30B_PROJECTOR.id });
  expect(record.engineRequirements.launch).toEqual({ chatTemplateKwargs: { reasoning_strength: "low" }, imageMaxTokens: 2560 });
  expect(record.verifiedAt).toBe(verifiedAt);
  expect(record.modelPath).toBe("/tmp/muse.gguf");
  expect(reconcilePinDeclarations(STACK_MODELS)).toEqual([]);
});

test("a record of different bytes under the same id is left alone", () => {
  const stale = installStaleMuse();
  upsertModel({ ...stale, sha256: "0".repeat(64), verifiedAt });
  expect(reconcilePinDeclarations(STACK_MODELS)).toEqual([]);
  expect(getModel(STACK_CHAT_MUSE_30B_XL_MODEL.id)!.engineRequirements.imageInput).toBeUndefined();
});

test("a text-only chat process restarts when the projector arrives; one that loaded it does not", async () => {
  installStaleMuse();
  reconcilePinDeclarations(STACK_MODELS);
  let launches = 0;
  setSupervisorFactoryForTests(async (role) => { launches++; return scriptedProcess(role, { kind: "spawned", imageInput: false, projectorLoaded: false, modelId: STACK_CHAT_MUSE_30B_XL_MODEL.id }); });
  await getProcess("chat");
  expect(launches).toBe(1);
  // The projector is not installed yet: nothing to restart for.
  expect(await restartForNewProjector()).toEqual([]);
  installProjector();
  expect(await restartForNewProjector()).toEqual(["chat"]);
  setSupervisorFactoryForTests(async (role) => { launches++; return scriptedProcess(role, { kind: "spawned", imageInput: true, projectorLoaded: true, modelId: STACK_CHAT_MUSE_30B_XL_MODEL.id }); });
  await getProcess("chat");
  expect(launches).toBe(2);
  expect(await restartForNewProjector()).toEqual([]);
});
