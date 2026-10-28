// DUPLEX-02: POST /v1/audio/endpoint answers whether the speaker has finished.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/app";
import { __resetHealthForTests } from "@/lib/health";
import { clearModelsForTests, upsertModel } from "@/lib/modelStore";
import { resetSupervisorForTests, scriptedProcess, setSupervisorFactoryForTests } from "@/lib/supervisor";
import { __resetSettingsForTests } from "@/settings";
import { __resetSmartTurnForTests } from "@/speech/smartTurn";
import { SttEndpointResponse } from "@maipai/spec/stack/ts/stt-endpoint-response.js";

const clipPath = join(import.meta.dir, "..", "src", "speech", "fixtures", "clover-two-seconds.wav");

beforeEach(() => { __resetHealthForTests(); __resetSettingsForTests(); clearModelsForTests(); __resetSmartTurnForTests(); setSupervisorFactoryForTests(async (role) => scriptedProcess(role)); });
afterEach(() => { setSupervisorFactoryForTests(null); resetSupervisorForTests(); clearModelsForTests(); });

function post(bytes: Uint8Array | null): Promise<Response> {
  const form = new FormData();
  if (bytes) form.append("file", new Blob([bytes], { type: "audio/wav" }), "clip.wav");
  return Promise.resolve(app.request("/v1/audio/endpoint", { method: "POST", body: form }));
}

test("without the end-of-turn model the route says so and names the fix", async () => {
  const response = await post(new Uint8Array(readFileSync(clipPath)));
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ reason: "endpoint-model-missing", error: expect.stringContaining("not installed") });
});

test("a missing file is a 400 and a non-WAV body is a 400 with the reason", async () => {
  expect((await post(null)).status).toBe(400);
  const verified = { source: "catalog" as const, provenance: {}, revision: "r", sha256: "c".repeat(64), licence: "BSD-2-Clause", verifiedAt: new Date().toISOString() };
  upsertModel({ id: "smart-turn-test", roles: ["stt"], ...verified, modelPath: "/models/none.onnx", engineRequirements: { engine: "onnxruntime-web", component: "endpoint" } });
  const bad = await post(new TextEncoder().encode("not a wav file at all"));
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toContain("WAV");
});

// The 8 MB model is downloaded, never vendored: set SMART_TURN_MODEL to a local copy.
const MODEL = process.env.SMART_TURN_MODEL;
test.skipIf(!MODEL || !existsSync(MODEL))("with the real model the route answers the spec shape with a probability", async () => {
  const verified = { source: "catalog" as const, provenance: {}, revision: "r", sha256: "c".repeat(64), licence: "BSD-2-Clause", verifiedAt: new Date().toISOString() };
  upsertModel({ id: "smart-turn-test", roles: ["stt"], ...verified, modelPath: MODEL!, engineRequirements: { engine: "onnxruntime-web", component: "endpoint" } });
  const response = await post(new Uint8Array(readFileSync(clipPath)));
  expect(response.status).toBe(200);
  const body = SttEndpointResponse.parse(await response.json());
  expect(body.probability).toBeGreaterThanOrEqual(0);
  expect(body.probability).toBeLessThanOrEqual(1);
  expect(body.complete).toBe(body.probability > 0.5);
});
