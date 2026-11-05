import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { listModels } from "@/lib/modelStore";
import { modelView } from "@/routes/models";
import { recordedSpeech, RECORDED_SPEECH_IDLE_MS, RECORDED_SPEECH_MAX_REFERENCE_BYTES, RECORDED_SPEECH_MAX_TEXT, RECORDED_SPEECH_NAME, RECORDED_SPEECH_PEAK_BYTES, RECORDED_SPEECH_VERSION } from "@/recordedSpeech/recordedSpeech";
import { recordedSpeechInstallModels } from "@/lib/installPlan";
import { getGovernorStatus } from "@/lib/governor";
import { getReducedChatState } from "@/lib/reducedChat";
import { STACK_RECORDED_SPEECH_MODEL_ID } from "@/lib/modelCatalog";

const Model = z.object({ id: z.string(), role: z.string(), repo: z.string().optional(), url: z.string(), sha256: z.string(), approx_bytes: z.number().int(), licence: z.string(), revision: z.string(), engine: z.string().optional(), archive: z.boolean().optional(), hub_file: z.string().optional(), component: z.string().optional(), starter: z.boolean(), installed: z.boolean() });
const route = createRoute({ method: "get", path: "/", tags: ["Recorded speech"], summary: "Recorded speech availability and limits", responses: { 200: { content: { "application/json": { schema: z.object({ recorded_speech: z.object({ state: z.string(), available: z.boolean(), engine: z.string(), version: z.string(), model: z.object({ id: z.string(), installed: z.boolean() }), models: z.array(Model), installed: z.boolean(), ready: z.boolean(), limits: z.object({ max_text_chars: z.number(), max_reference_mb: z.number(), reference_min_seconds: z.number(), reference_max_seconds: z.number(), max_speakers: z.number(), peak_bytes: z.number(), idle_exit_seconds: z.number() }) }) }) } }, description: "Recorded speech status." } } });
export const recordedSpeechRoutes = apiRouter<AppEnv>();
recordedSpeechRoutes.openapi(route, (c) => {
  const governor = getGovernorStatus();
  const resident = governor.loaded.filter((item) => item.kind === "resident").reduce((sum, item) => sum + item.peakBytes, 0);
  const supportedTier = governor.tier !== "p16" && governor.tier !== "p32" && getReducedChatState() !== "reduced" && resident + RECORDED_SPEECH_PEAK_BYTES <= governor.capBytes;
  const available = recordedSpeech.depsAvailable && supportedTier;
  const installedIds = listModels().map(modelView).filter((model) => model.state === "installed").map((model) => model.id);
  const installed = recordedSpeechInstallModels(installedIds).some((model) => model.id === STACK_RECORDED_SPEECH_MODEL_ID && model.installed);
  return c.json({ recorded_speech: { state: !available ? "unsupported" : recordedSpeech.state, available, engine: RECORDED_SPEECH_NAME, version: RECORDED_SPEECH_VERSION, model: { id: STACK_RECORDED_SPEECH_MODEL_ID, installed }, models: recordedSpeechInstallModels(installedIds).map((model) => ({ ...model, installed: recordedSpeech.installed })), installed: recordedSpeech.installed, ready: recordedSpeech.installed && recordedSpeech.state === "idle", limits: { max_text_chars: RECORDED_SPEECH_MAX_TEXT, max_reference_mb: RECORDED_SPEECH_MAX_REFERENCE_BYTES / (1024 * 1024), reference_min_seconds: 6, reference_max_seconds: 30, max_speakers: 4, peak_bytes: RECORDED_SPEECH_PEAK_BYTES, idle_exit_seconds: RECORDED_SPEECH_IDLE_MS / 1000 } } }, 200 as const);
});
