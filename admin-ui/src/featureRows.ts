import { useSyncExternalStore } from "react";

/** The Stack's feature rows as the admin UI needs them: which role each feature serves, its icon name, and the order the Stack lists them in. Filled once from GET /stack/v1/choices. */
export interface FeatureRowLite { role: string | null; icon: string }

let rows: FeatureRowLite[] = [];
let version = 0;
const listeners = new Set<() => void>();

export function setFeatureRows(next: FeatureRowLite[]): void {
  rows = next;
  version += 1;
  for (const listener of listeners) listener();
}
export function featureIconName(role: string): string | undefined {
  return rows.find((row) => row.role === role)?.icon;
}
/** Role ids in the order the Stack lists its features. */
export function featureOrder(): string[] {
  return rows.flatMap((row) => (row.role ? [row.role] : []));
}
export function subscribeFeatureRows(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function getFeatureRowsVersion(): number { return version; }
/** Re-renders the caller when the rows load, so icons and colors follow them. */
export function useFeatureRows(): number {
  return useSyncExternalStore(subscribeFeatureRows, getFeatureRowsVersion);
}
