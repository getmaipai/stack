// What the chat engine in effect needs on disk (ENGINE-MLX-01). Only when
// the setting names oMLX does the Stack build its environment in the
// background at start and move chat onto oMLX once an MLX chat model is
// installed and verified. No MLX chat model is pinned as a default (the
// owner removed the one that was, 2026-11-17): the model is whatever the
// admin installed, so the Stack fetches none itself. `auto` is llama-server (ENGINE-MLX-02), so under `auto` and
// `llama-server` nothing is fetched. Until the pieces are verified chat keeps
// answering on llama-server. Never throws: a missing engine never stops chat
// (a Repairs item says what is missing).
import { PRIMARY_ROLE } from "@/roles";
import { existsSync } from "node:fs";
import { ensureOmlxEnvironment, omlxInstalled, omlxSupportedHere } from "@/chat/omlx";
import { CHAT_ENGINE_SETTING, requestedChatEngine } from "@/lib/chatEngines";
import { detectHardware } from "@/lib/hardware";
import { raise, resolve as resolveHealth } from "@/lib/health";
import { createJob, finishJob, jobSignal, updateJob } from "@/lib/jobs";
import { isModelSelectable, listModels } from "@/lib/modelStore";
import { activeChatChoice, currentMachineTier, restartForNewChatEngine, runningEngine } from "@/lib/supervisor";
import { emit } from "@/lib/events";
import { settingValues } from "@/settings";
import { warmUp } from "@/lib/warmup";

export const CHAT_ASSETS_CODE = "chat.engine-assets";
/** Disk the environment needs, plus room to work. */
const DISK_MARGIN_BYTES = 6 * 1024 ** 3;

/** An installed, verified chat model that oMLX runs is on disk. */
function mlxModelOnDisk(): boolean {
  return listModels().some((model) => model.roles.includes(PRIMARY_ROLE) && model.engineRequirements.engine === "omlx" && !model.engineRequirements.component && isModelSelectable(model) && !!model.modelPath && existsSync(model.modelPath));
}

/** A chat model (the GGUF the install plan or Home put there) is installed: the person has a working chat to keep. */
function chatInstalled(): boolean {
  return listModels().some((model) => model.roles.includes(PRIMARY_ROLE) && model.engineRequirements.engine === "llama-server" && !model.engineRequirements.component && isModelSelectable(model) && !!model.modelPath);
}

let inFlight: Promise<void> | null = null;

/** Builds the oMLX environment when this machine's engine setting wants oMLX and it is missing; the model is whichever MLX chat model is installed. */
export function ensureChatEngineAssets(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = run().catch(() => undefined).finally(() => { inFlight = null; });
  return inFlight;
}

async function run(): Promise<void> {
  const requested = requestedChatEngine(settingValues()[CHAT_ENGINE_SETTING], currentMachineTier());
  if (requested !== "omlx") return;
  const supported = omlxSupportedHere();
  if (!supported.ok) return;
  // A fresh install carries the environment through the install plan; this is the upgrade path, so a Mac with no chat model yet waits for the plan.
  if (!chatInstalled() && !mlxModelOnDisk()) return;
  const wantEnvironment = !omlxInstalled();
  if (!wantEnvironment) { await switchWhenReady(); return; }
  const free = (await detectHardware()).freeDiskBytes ?? null;
  const need = 2 * 1024 ** 3 + DISK_MARGIN_BYTES;
  if (free !== null && free < need) {
    raise({ code: CHAT_ASSETS_CODE, severity: "warning", title: "Chat stays on llama-server: not enough disk for oMLX", text: `oMLX's environment needs about ${Math.ceil(need / 1024 ** 3)} GB free; ${Math.floor(free / 1024 ** 3)} GB is free. Chat keeps working on llama-server.`, cause: "Not enough free disk space.", fix: { label: "Try again", action: "restart_engine" } });
    return;
  }
  try {
    if (wantEnvironment) {
      const job = createJob({ kind: "engine.install", totalBytes: 0, status: "downloading", input: { engine: "omlx-env" } });
      try {
        await ensureOmlxEnvironment((phase) => updateJob(job.id, { status: `building ${phase}` }), { signal: jobSignal(job.id) });
        finishJob(job.id, { ok: true, result: { engine: "omlx" } });
        emit({ id: "engine.state", data: { engine: "omlx", state: "installed" } });
      } catch (error) { finishJob(job.id, { ok: false, reason: error instanceof Error ? error.message : String(error) }); throw error; }
    }
    resolveHealth(CHAT_ASSETS_CODE);
    await switchWhenReady();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    raise({ code: CHAT_ASSETS_CODE, severity: "warning", title: "oMLX could not be installed; chat stays on llama-server", text: reason, cause: reason, fix: { label: "Try again", action: "restart_engine" } });
  }
}

/** Both pieces are on disk: move an idle llama-server chat onto oMLX. A
 * chat busy answering is tried again every 30 seconds for ten minutes. */
export async function switchWhenReady(attempts = 20, waitMs = 30_000): Promise<boolean> {
  if (!omlxInstalled() || !mlxModelOnDisk()) return false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const running = runningEngine(PRIMARY_ROLE);
    if (running === null || running === activeChatChoice().engine) return false;
    if (await restartForNewChatEngine().catch(() => false)) { await warmUp("chat-engine-ready").catch(() => undefined); return true; }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return false;
}
