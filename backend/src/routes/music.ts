// The music role's state and install pieces (MUSIC-GEN-01). The songs themselves
// are POST /v1/audio/music. Home enables its music control from
// GET /stack/v1/music, installs the pieces it lists (the engine build through
// POST /stack/v1/engines/music-gen/install, the pinned models through
// POST /stack/v1/models), and offers the quality choices it lists. Shaped like
// GET /stack/v1/video.
import { engineIdleMs } from "@/lib/engineIdle";
import { join } from "node:path";
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { installedEnginePin } from "@/lib/engineCatalog";
import { getModel, listModels } from "@/lib/modelStore";
import { musicInstallModels, musicMaxInstallModels, musicXlInstallModels } from "@/lib/installPlan";
import { modelView } from "@/routes/models";
import {
  memoryVerdict, MUSIC_DEFAULT_SECONDS, MUSIC_GEN_NAME, MUSIC_GEN_VERSION, MUSIC_MAX_BPM, MUSIC_MAX_EXTEND_SECONDS, MUSIC_MAX_SOURCE_BYTES, MUSIC_MAX_TEXT_CHARS, MUSIC_MIN_BPM, MUSIC_MIN_EXTEND_SECONDS,
  MUSIC_MIN_SECONDS, MUSIC_PEAK_BYTES, MUSIC_QUEUE_MAX, musicGen, musicGenEnvironmentReady, musicWhisperRuntimeAvailable, musicGenSourceInstalled, tierAvailability, tierLimits,
} from "@/music/musicGen";
import { STACK_MUSIC_MODEL_ID, STACK_MUSIC_SFT_ID, STACK_MUSIC_WHISPER_ID, STACK_MUSIC_XL_ID } from "@/lib/modelCatalog";

const PlanModelSchema = z.object({
  id: z.string(), role: z.string(), repo: z.string().optional(), url: z.string(), sha256: z.string(), approx_bytes: z.number().int(), licence: z.string(), revision: z.string(),
  engine: z.string().optional(), archive: z.boolean().optional(), hub_file: z.string().optional(), component: z.string().optional(), starter: z.boolean(), installed: z.boolean(),
});
const StatusSchema = z.object({
  state: z.enum(["unsupported", "off", "not-installed", "needs-setup", "building", "idle", "running"]).openapi({ description: "off: this computer's tier does not run music. not-installed: the model files are missing. needs-setup: installed; the first song builds the environment (first time only) and starts the worker. idle: the worker is up and waits five minutes for the next song, then exits. running: a song is in progress." }),
  available: z.boolean(), code: z.string().nullable(), reason: z.string().nullable(), tier: z.string(),
  memory: z.object({ fits: z.boolean(), reason: z.string().nullable(), peak_gb: z.number() }).openapi({ description: "Whether a song could be admitted next to what is resident now. A requested sung-words transcript adds 2 GB to the admission peak." }),
  model: z.object({ id: z.string(), installed: z.boolean() }),
  transcribe: z.object({ available: z.boolean() }),
  limits: z.record(z.string(), z.union([z.number(), z.string()])),
  quality: z.array(z.enum(["quick", "detailed", "max"])).openapi({ description: "The qualities this computer offers: quick (Standard, the 0.6B planning model) and, on a 128 GB computer, detailed (Boost, 1.7B) and max (Max, XL SFT with the 4B planner). Empty when music is off." }),
  default_quality: z.enum(["quick", "detailed", "max"]).nullable(),
  tasks: z.array(z.string()),
  worker: z.object({ alive: z.boolean(), idle_exit_seconds: z.number().int() }),
  environment: z.object({ engine: z.string(), version: z.string(), source: z.boolean(), ready: z.boolean() }),
  boost_model: z.object({ id: z.string(), installed: z.boolean(), models: z.array(PlanModelSchema), remaining_bytes: z.number().int() }).nullable().openapi({ description: "MUSIC-XL-01: the larger song model (ACE-Step XL Turbo, bf16) the detailed quality uses when installed, with the pins to pull; null on a computer that offers no detailed quality. Without it detailed songs use the standard model. Additive." }),
  max_model: z.object({ id: z.string(), installed: z.boolean(), models: z.array(PlanModelSchema), remaining_bytes: z.number().int() }).nullable().openapi({ description: "MUSIC-MAX-01: the Max song model (ACE-Step XL SFT) and its 4B planning model, with the pins to pull; null on a computer that offers no max quality. Without them max songs run as detailed. Additive." }),
  install: z.object({ models: z.array(PlanModelSchema), remaining_bytes: z.number().int() }).openapi({ description: "The pinned models to pull (POST /stack/v1/models, shaped as an install-plan model) and how many bytes are still to come." }),
});
const statusRoute = createRoute({ method: "get", path: "/", tags: ["Music"], summary: "The music role's state, limits, and what to install", responses: { 200: { content: { "application/json": { schema: z.object({ music: StatusSchema }) } }, description: "Additive. Home enables its music control from `available` and `state`." } } });

export const musicRoutes = apiRouter<AppEnv>();

musicRoutes.openapi(statusRoute, (c) => {
  const availability = tierAvailability();
  const status = musicGen.status();
  const tierLimit = availability.available ? tierLimits(availability.tier) : null;
  const installed = listModels().map(modelView).filter((model) => model.state === "installed").map((model) => model.id);
  const models = musicInstallModels(installed);
  const boostModels = musicXlInstallModels(installed);
  const maxModels = musicMaxInstallModels(installed);
  const verdict = memoryVerdict();
  const pin = installedEnginePin(MUSIC_GEN_NAME);
  return c.json({ music: {
    state: status.state, available: availability.available, code: availability.code, reason: availability.reason, tier: availability.tier,
    memory: { fits: verdict.ok, reason: verdict.ok ? null : verdict.reason, peak_gb: Math.round(MUSIC_PEAK_BYTES / 1e8) / 10 },
    model: { id: STACK_MUSIC_MODEL_ID, installed: models.every((model) => model.installed) },
    transcribe: { available: !!(() => { const model = getModel(STACK_MUSIC_WHISPER_ID); if (!model?.verifiedAt || !model.modelPath || !musicWhisperRuntimeAvailable()) return false; try { return Bun.file(join(model.modelPath, "weights.npz")).size > 0 && Bun.file(join(model.modelPath, "config.json")).size > 0; } catch { return false; } })() },
    limits: {
      min_seconds: MUSIC_MIN_SECONDS, max_seconds: tierLimit?.max_seconds ?? 0, default_seconds: Math.min(MUSIC_DEFAULT_SECONDS, tierLimit?.max_seconds ?? 0), min_bpm: MUSIC_MIN_BPM, max_bpm: MUSIC_MAX_BPM,
      min_extend_seconds: MUSIC_MIN_EXTEND_SECONDS, max_extend_seconds: MUSIC_MAX_EXTEND_SECONDS, max_text_chars: MUSIC_MAX_TEXT_CHARS, max_source_mb: MUSIC_MAX_SOURCE_BYTES / 1024 / 1024, queue_max: MUSIC_QUEUE_MAX,
    },
    quality: tierLimit?.quality ?? [], default_quality: tierLimit?.default_quality ?? null,
    tasks: availability.available ? ["text2music", "cover", "repaint", "extend", "edit"] : [],
    worker: { alive: musicGen.workerAlive, idle_exit_seconds: Math.round(engineIdleMs("music") / 1000) },
    environment: { engine: pin ? `${pin.name} ${pin.tag}` : MUSIC_GEN_NAME, version: MUSIC_GEN_VERSION, source: musicGenSourceInstalled(), ready: musicGenEnvironmentReady() },
    boost_model: tierLimit?.quality.includes("detailed") ? { id: STACK_MUSIC_XL_ID, installed: boostModels.every((model) => model.installed), models: boostModels, remaining_bytes: boostModels.filter((model) => !model.installed).reduce((sum, model) => sum + model.approx_bytes, 0) } : null,
    max_model: tierLimit?.quality.includes("max") ? { id: STACK_MUSIC_SFT_ID, installed: maxModels.every((model) => model.installed), models: maxModels, remaining_bytes: maxModels.filter((model) => !model.installed).reduce((sum, model) => sum + model.approx_bytes, 0) } : null,
    install: { models, remaining_bytes: models.filter((model) => !model.installed).reduce((sum, model) => sum + model.approx_bytes, 0) },
  } }, 200 as const);
});
