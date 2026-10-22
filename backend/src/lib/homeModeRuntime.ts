import { settingValues, updateSettings } from "@/settings";
import { STACK_CODING_HEAVY_MODEL, STACK_CODING_HEAVY_DRAFT_MODEL } from "@/lib/modelCatalog";
import { isComponent, listModels } from "@/lib/modelStore";
import { getGovernorStatus, setCodingModeActive } from "@/lib/governor";
import { splashFootprintEstimateBytes } from "@/lib/splash";
import { currentEngineTag } from "@/lib/engineInstall";
import { configureHomeMode, homeModeFailure, initializeHomeMode, switchHomeMode, type HomeMode, type HomeModeChecks, type HomeModeMemory, type HomeModeRuntime } from "@/lib/homeMode";
import { codingModeHardwareEligible, emitHomeModeReady, emitHomeModeTransition, getProcess, getRoleStatus, processRoleFor, splashInstalledForHomeMode, unloadRole, type EngineClient } from "@/lib/supervisor";

const GIB = 1_073_741_824;
const HEAVY_ROLES = ["chat", "judge", "router"] as const;
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
  const heavy = models.find((item) => item.id === STACK_CODING_HEAVY_MODEL.id);
  const draft = models.find((item) => item.id === STACK_CODING_HEAVY_DRAFT_MODEL.id);
  const contextTokens = Number(settingValues()["stack.engines.coding.context_length"] ?? 131_072);
  const plan = splashFootprintEstimateBytes({ weightsBytes: heavy?.sizeBytes ?? STACK_CODING_HEAVY_MODEL.download!.approx_bytes, draftBytes: draft?.sizeBytes ?? STACK_CODING_HEAVY_DRAFT_MODEL.download!.approx_bytes, contextTokens });
  const budget = Math.max(0, governor.capBytes - residentBytes - governor.marginBytes);
  return { memory: { plan_bytes: plan, budget_bytes: budget }, fits: plan <= budget };
}
function checks(): { checks: HomeModeChecks; reason: string | null; memory: HomeModeMemory } {
  const engine = splashInstalledForHomeMode();
  const pieces = modelInstalled(STACK_CODING_HEAVY_MODEL.id) && modelInstalled(STACK_CODING_HEAVY_DRAFT_MODEL.id);
  const hardware = codingModeHardwareEligible();
  const planned = memoryPlan();
  // STACK_HOME_MODE_VERDICT_TEST is for the measurement run only (MODE-BENCH-01 has to enter the mode before a verdict can be recorded). A household never sets it.
  const testVerdict = process.env.STACK_HOME_MODE_VERDICT_TEST;
  const benchVerdict = testVerdict === "offer" || testVerdict === "offer_with_limits" ? testVerdict : STACK_CODING_HEAVY_MODEL.modeVerdict ?? "pending";
  const bench = benchVerdict === "offer" || benchVerdict === "offer_with_limits";
  const result: HomeModeChecks = { engine, pieces, hardware, memory: planned.fits, bench };
  const reason = !bench ? benchVerdict === "do_not_offer" ? "The large coding model did not pass its measurements on this kind of computer." : "The large coding model has not been measured on this kind of computer yet."
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
  const base = { model: STACK_CODING_HEAVY_MODEL.id, messages: [{ role: "user", content: "Reply with the word ready." }], max_tokens: 32 };
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
  const process = await getProcess("coding", STACK_CODING_HEAVY_MODEL.id);
  await checkHomeModeOpenAIWire(process.client);
}

export async function setupHomeModeRuntime(initial: HomeMode): Promise<void> {
  const adapter: HomeModeRuntime = {
    inspect: () => { const result = checks(); return { ...result, available: Object.values(result.checks).every(Boolean), reason: result.reason }; },
    stopResidents: async () => {
      for (const role of HEAVY_ROLES) {
        const owner = processRoleFor(role);
        if (role === owner || (role === "judge" && owner === "judge")) await unloadRole(owner, "Home is changing modes.");
      }
    },
    startHeavy: async () => { setCodingModeActive(true); await retryWhileResidentStarts(() => getProcess("coding", STACK_CODING_HEAVY_MODEL.id)); },
    stopHeavy: async () => { await unloadRole("coding", "Home is changing modes."); },
    startResidents: async () => {
      setCodingModeActive(false);
      await getProcess("chat");
      if (getRoleStatus("judge").state !== "notInstalled") await getProcess("judge");
    },
    checkHeavy: postLoadCodingCheck,
    bind: (mode) => { setCodingModeActive(mode === "coding"); emitHomeModeReady(); },
    transition: () => { setCodingModeActive(true); emitHomeModeTransition(); },
    persistMode: (mode) => { updateSettings({ "stack.engines.coding.home_mode": mode }); },
    generating: () => getGovernorStatus().loaded.some((entry) => entry.kind === "generator"),
    pins: () => JSON.stringify([currentEngineTag("splash") ?? "", STACK_CODING_HEAVY_MODEL.revision, STACK_CODING_HEAVY_DRAFT_MODEL.revision]),
  };
  configureHomeMode(adapter); initializeHomeMode("normal");
  if (initial === "coding") await switchHomeMode("coding").catch((error) => {
    const reason = error instanceof Error ? error.message : String(error);
    homeModeFailure(reason, "unavailable");
    updateSettings({ "stack.engines.coding.home_mode": "normal" });
  });
}
