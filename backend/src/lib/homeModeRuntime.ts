import { settingValues, updateSettings } from "@/settings";
import { MODE_FOLLOWER_ROLES, HEAVY_ROLE, PRIMARY_ROLE } from "@/roles";
import { STACK_CODING_MODEL } from "@/lib/modelCatalog";
import { codingModeHeavy, splashMeasuredPeakBytes, splashResidentWeightsBytes } from "@/lib/splashStore";
import { isComponent, listModels } from "@/lib/modelStore";
import { getGovernorStatus, setCodingModeActive } from "@/lib/governor";
import { splashFootprintEstimateBytes } from "@/lib/splash";
import { currentEngineTag } from "@/lib/engineInstall";
import { configureHomeMode, homeModeFailure, initializeHomeMode, switchHomeMode, type HomeMode, type HomeModeChecks, type HomeModeMemory, type HomeModeRuntime } from "@/lib/homeMode";
import { codingModeHardwareEligible, emitHomeModeReady, emitHomeModeTransition, getProcess, getRoleStatus, processRoleFor, splashInstalledForHomeMode, unloadRole, type EngineClient } from "@/lib/supervisor";

const GIB = 1_073_741_824;
const STAYING_ROLES = ["embed", "stt", "tts"] as const;

export function homeModeStayingResidentBytes(loaded: Array<{ id: string; peakBytes: number }>): number {
  return loaded.filter((item) => (STAYING_ROLES as readonly string[]).includes(item.id)).reduce((sum, item) => sum + item.peakBytes, 0);
}

function modelInstalled(id: string): boolean {
  const model = listModels().find((item) => item.id === id);
  return !!model?.modelPath && !!model.verifiedAt;
}
function memoryPlan(): { memory: HomeModeMemory; fits: boolean } {
  const governor = getGovernorStatus();
  const models = listModels();
  const loadedStaying = homeModeStayingResidentBytes(governor.loaded);
  const residentBytes = STAYING_ROLES.reduce((sum, role) => {
    if (governor.loaded.some((item) => item.id === role)) return sum;
    const model = models.find((item) => item.roles.includes(role) && !isComponent(item));
    return sum + (model?.measuredFootprintBytes ?? Math.ceil((model?.sizeBytes ?? 0) * 1.3));
  }, loadedStaying);
  const { pin, draftPin } = codingModeHeavy();
  const heavy = models.find((item) => item.id === pin.id);
  const draft = models.find((item) => item.id === draftPin.id);
  // A pinned window (Flash Next's 32K) is the window the launch uses; otherwise the coding setting's.
  const asked = Number(settingValues()["stack.engines.coding.max_chat_context_length"]);
  const contextTokens = pin.launch?.contextLength != null ? Math.max(pin.launch.contextLength, Number.isFinite(asked) ? Math.floor(asked) : 0) : Number(settingValues()["stack.engines.coding.context_length"] ?? 131_072);
  const measuredPeak = splashMeasuredPeakBytes(pin.id);
  const plan = measuredPeak ?? splashFootprintEstimateBytes({ weightsBytes: splashResidentWeightsBytes(pin.id, heavy?.sizeBytes ?? pin.download!.approx_bytes), draftBytes: draft?.sizeBytes ?? draftPin.download!.approx_bytes, contextTokens });
  // A model with a measured peak is checked by the rule the governor admits it by (the model budget less what stays, and the machine's total less what stays and the working margin: whichever is smaller), because the margin is a reserve against free memory, not a second deduction from the budget. A model without a measurement keeps the stricter formula check.
  const budget = measuredPeak !== null
    ? Math.max(0, Math.min(governor.capBytes - residentBytes, governor.totalMemoryBytes - residentBytes - governor.marginBytes))
    : Math.max(0, governor.capBytes - residentBytes - governor.marginBytes);
  return { memory: { plan_bytes: plan, budget_bytes: budget }, fits: plan <= budget };
}
function checks(): { checks: HomeModeChecks; reason: string | null; memory: HomeModeMemory } {
  const engine = splashInstalledForHomeMode();
  const heavyPair = codingModeHeavy();
  const pieces = modelInstalled(heavyPair.pin.id) && modelInstalled(heavyPair.draftPin.id);
  const hardware = codingModeHardwareEligible();
  const planned = memoryPlan();
  // STACK_HOME_MODE_VERDICT_TEST is for the measurement run only (MODE-BENCH-01 has to enter the mode before a verdict can be recorded). A household never sets it.
  const testVerdict = process.env.STACK_HOME_MODE_VERDICT_TEST;
  const benchVerdict = testVerdict === "offer" || testVerdict === "offer_with_limits" ? testVerdict : heavyPair.pin.modeVerdict ?? "pending";
  const bench = benchVerdict === "offer" || benchVerdict === "offer_with_limits";
  const result: HomeModeChecks = { engine, pieces, hardware, memory: planned.fits, bench };
  // With Flash Next not installed the mode's pick is the everyday 27B, which already does the everyday coding outside the mode: the mode is not offered, and says why.
  const reason = !bench && heavyPair.pin.id === STACK_CODING_MODEL.id ? "The large coding mode needs the Flash Next model, which is not installed. Qwen3.8 27B keeps doing everyday coding."
    : !bench ? benchVerdict === "do_not_offer" ? "The large coding model did not pass its measurements on this kind of computer." : "The large coding model has not been measured on this kind of computer yet."
    : !hardware ? "The large coding model needs a p128 Apple silicon Mac with macOS 26.4 or later and an M3 chip or newer."
      : !engine ? "Splash is not installed on this computer."
        : !pieces ? "The large coding model and its draft are not both installed and verified."
          : !planned.fits ? "This computer cannot hold the large coding model and the voice and search parts together."
            : null;
  return { checks: result, reason, memory: planned.memory };
}

function textReply(body: unknown): string | null {
  const root = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const choices = root.choices as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  return typeof message?.content === "string" && message.content.trim() ? message.content : null;
}
export async function checkHomeModeOpenAIWire(client: Pick<EngineClient, "request">): Promise<void> {
  const base = { model: codingModeHeavy().pin.id, messages: [{ role: "user", content: "Reply with the word ready." }], max_tokens: 32 };
  const plain = await client.request("/v1/chat/completions", { ...base, reasoning_effort: "none" });
  if (plain.status < 200 || plain.status >= 300 || !textReply(plain.body)) throw new Error("The large coding model did not complete its basic check.");
  const tool = await client.request("/v1/chat/completions", { ...base, messages: [{ role: "user", content: "Call the check tool now." }], tools: [{ type: "function", function: { name: "home_mode_check", description: "Report a successful check.", parameters: { type: "object", properties: {}, required: [] } } }], tool_choice: "required", max_tokens: 64 });
  const choices = (tool.body as { choices?: Array<{ message?: { tool_calls?: unknown[] } }> })?.choices;
  if (tool.status < 200 || tool.status >= 300 || !choices?.[0]?.message?.tool_calls?.length) throw new Error("The large coding model did not complete its tool check.");
  const thinking = await client.request("/v1/chat/completions", { ...base, reasoning_effort: "low", thinking_budget_tokens: 128 });
  if (thinking.status < 200 || thinking.status >= 300 || !textReply(thinking.body)) throw new Error("The large coding model did not complete its thinking check.");
}
/** A resident engine that is still warming up holds the large model back (its start guard throws). A mode switch waits for it
 * instead of failing, up to `waitMs`, because a switch right after boot is a normal thing to do. */
export async function retryWhileResidentStarts<T>(start: () => Promise<T>, waitMs = 5 * 60_000, pauseMs = 1_000): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { return await start(); }
    catch (error) {
      const waiting = error instanceof Error && error.message.includes("waits while a resident engine starts");
      if (!waiting || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }
}
async function postLoadCodingCheck(): Promise<void> {
  const process = await getProcess(HEAVY_ROLE, codingModeHeavy().pin.id);
  await checkHomeModeOpenAIWire(process.client);
}

/** Sets the mode runtime up and returns at once. Restoring a persisted "coding" mode continues in the background (see `homeModeRestore`). */
export async function setupHomeModeRuntime(initial: HomeMode): Promise<void> {
  restore = null;
  const adapter: HomeModeRuntime = {
    inspect: () => { const result = checks(); return { ...result, available: Object.values(result.checks).every(Boolean), reason: result.reason }; },
    stopResidents: async () => {
      for (const role of MODE_FOLLOWER_ROLES) {
        const owner = processRoleFor(role);
        if (role === owner || (role === "judge" && owner === "judge")) await unloadRole(owner, "Home is changing modes.", "home-mode-change");
      }
    },
    // A resident start already past its guard when the switch began can finish after stopResidents; stop it again before the large model asks for memory.
    startHeavy: async () => { setCodingModeActive(true); await adapter.stopResidents(); await retryWhileResidentStarts(() => getProcess(HEAVY_ROLE, codingModeHeavy().pin.id)); },
    stopHeavy: async () => { await unloadRole(HEAVY_ROLE, "Home is changing modes.", "home-mode-change"); },
    startResidents: async () => {
      setCodingModeActive(false);
      await getProcess(PRIMARY_ROLE);
      if (getRoleStatus("judge").state !== "notInstalled") await getProcess("judge");
    },
    checkHeavy: postLoadCodingCheck,
    bind: (mode) => { setCodingModeActive(mode === HEAVY_ROLE); emitHomeModeReady(); },
    transition: () => { setCodingModeActive(true); emitHomeModeTransition(); },
    persistMode: (mode) => { updateSettings({ "stack.engines.coding.home_mode": mode }); },
    generating: () => getGovernorStatus().loaded.some((entry) => entry.kind === "generator"),
    pins: () => JSON.stringify([currentEngineTag("splash") ?? "", codingModeHeavy().pin.revision, codingModeHeavy().draftPin.revision]),
  };
  configureHomeMode(adapter); initializeHomeMode("normal");
  if (initial === HEAVY_ROLE) {
    // STACK-START-01: the persisted mode is restored in the background. The large model takes minutes to load, and the Stack must already
    // answer /healthz and the status routes meanwhile (Home's installer waits only 20 s). switchHomeMode sets its "switching" state before
    // its first await, so every request and the startup warm-up see "entering coding" the moment this returns.
    restore = switchHomeMode(HEAVY_ROLE).catch((error) => {
      const reason = error instanceof Error ? error.message : String(error);
      homeModeFailure(reason, "unavailable");
      updateSettings({ "stack.engines.coding.home_mode": "normal" });
    }).catch(() => {});
  }
}

let restore: Promise<void> | null = null;
/** The restore of the persisted coding mode, still running or finished; null when the Stack started in Normal mode. Never rejects. */
export function homeModeRestore(): Promise<void> | null { return restore; }
