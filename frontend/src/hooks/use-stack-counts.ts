// One computation of the footer's operational counts, so the value
// shown there always matches the value a click lands on. UI-08's
// components summary route replaces this source without changing the
// hook's shape or callers.
import { useApiResource } from "@/lib/useApiResource";
import type { EngineRecord, HealthItem, RoleRecord } from "@/lib/api";

export interface StackCounts {
  updatesAvailable: number;
  componentsInstalled: number;
  componentsRunning: number;
  health: { severity: "critical" | "error" | "warning" | null; text: string };
}

const SEVERITY_RANK: Record<HealthItem["severity"], number> = { warning: 1, error: 2, critical: 3 };

export function useStackCounts(): StackCounts {
  const updates = useApiResource<{ app: { available: string | null }; engines: { available: string | null }; models: { available: string | null } }>("/stack/v1/updates");
  const models = useApiResource<{ models: unknown[] }>("/stack/v1/models");
  const engines = useApiResource<{ engines: EngineRecord[] }>("/stack/v1/engines");
  const roles = useApiResource<{ roles: RoleRecord[] }>("/stack/v1/roles");
  const health = useApiResource<{ health: HealthItem[] }>("/stack/v1/health");

  const updatesAvailable = updates.data ? [updates.data.app?.available, updates.data.engines?.available, updates.data.models?.available].filter(Boolean).length : 0;
  const matchingEngines = (engines.data?.engines ?? []).filter((engine) => engine.matchesThisMachine);
  const componentsInstalled = (models.data?.models ?? []).length + matchingEngines.length;
  const componentsRunning = (roles.data?.roles ?? []).filter((role) => role.state === "ready" || role.state === "busy").length;

  const worst = (health.data?.health ?? []).reduce<HealthItem | null>((current, item) => {
    if (!current || SEVERITY_RANK[item.severity] > SEVERITY_RANK[current.severity]) return item;
    return current;
  }, null);

  return {
    updatesAvailable,
    componentsInstalled,
    componentsRunning,
    health: worst ? { severity: worst.severity, text: worst.title } : { severity: null, text: "All systems operational" },
  };
}
