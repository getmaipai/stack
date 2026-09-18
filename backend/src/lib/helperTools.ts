import { list as listHealth } from "@/lib/health";
import { getChatEngineStatus } from "@/lib/supervisor";
import { listModels } from "@/lib/modelStore";
import { state as updateState } from "@/updates/check";
import { storageAccounting } from "@/lib/store/storage";

export interface HelperTool { name: string; description: string; mutating: false; run: () => unknown; }

export const HELPER_TOOLS: readonly HelperTool[] = [
  { name: "health", description: "Read current health and repair items.", mutating: false, run: () => listHealth() },
  { name: "engines", description: "Read the chat engine status.", mutating: false, run: () => getChatEngineStatus() },
  { name: "models", description: "Read installed model summaries.", mutating: false, run: () => listModels().map((model) => ({ id: model.id, roles: model.roles, installed: model.installedAt !== null })) },
  { name: "updates", description: "Read update status.", mutating: false, run: () => ({ app: updateState("app"), engines: updateState("engines"), models: updateState("models") }) },
  { name: "storage", description: "Read local storage accounting.", mutating: false, run: () => storageAccounting() },
  { name: "series", description: "Read local usage series.", mutating: false, run: () => ({ available: true }) },
];

export function helperToolRegistry(): readonly HelperTool[] { return HELPER_TOOLS; }
