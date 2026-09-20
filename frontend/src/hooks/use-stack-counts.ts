// One computation of the footer's operational counts, so the value
// shown there always matches the value a click lands on. UI-08's
// components summary route replaces this source without changing the
// hook's shape or callers.
import { useApiResource } from "@/lib/useApiResource";
import { roleState, type EngineRecord, type HealthItem, type RoleRecord } from "@/lib/api";
import { worstHealthItem } from "@/lib/health-severity";

export interface StackCounts {
  updatesAvailable: number;
  componentsInstalled: number;
  componentsRunning: number;
  health: { severity: "critical" | "error" | "warning" | null; text: string };
}

export function useStackCounts(): StackCounts {
  const updates = useApiResource<{ app: { available: string | null }; engines: { available: string | null }; models: { available: string | null } }>("/stack/v1/updates");
  const models = useApiResource<{ models: unknown[] }>("/stack/v1/models");
  const engines = useApiResource<{ engines: EngineRecord[] }>("/stack/v1/engines");
  const roles = useApiResource<{ roles: RoleRecord[] }>("/stack/v1/roles");
  const health = useApiResource<{ health: HealthItem[] }>("/stack/v1/health");

  const updatesAvailable = updates.data ? [updates.data.app?.available, updates.data.engines?.available, updates.data.models?.available].filter(Boolean).length : 0;
  // `installed`, not `matchesThisMachine`: the latter only means this
  // engine build is compatible with this platform/arch (EnginesPage.tsx
  // uses `installed` for the same "is it actually here" question).
  const installedEngines = (engines.data?.engines ?? []).filter((engine) => engine.installed);
  const componentsInstalled = (models.data?.models ?? []).length + installedEngines.length;
  const componentsRunning = (roles.data?.roles ?? []).filter((role) => roleState(role) === "ready" || roleState(role) === "loaded").length;

  const worst = worstHealthItem(health.data?.health ?? []);

  return {
    updatesAvailable,
    componentsInstalled,
    componentsRunning,
    health: worst ? { severity: worst.severity, text: worst.title } : { severity: null, text: "All systems operational" },
  };
}
