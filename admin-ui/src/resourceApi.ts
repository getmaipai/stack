// The Resources screen's reads, beside api.ts so that file stays as other screens left it.
// Read only, same-origin, the session cookie rides along.
import { ApiError } from "./api";
import type { EngineRow, Engines, History, Marker, Range } from "./resourceData";

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } });
  const text = await response.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!response.ok) {
    const fail = (data ?? {}) as { error?: string; code?: string };
    throw new ApiError(fail.error ?? `The Stack answered ${response.status}. Try again, and check the log if it keeps happening.`, response.status, fail.code ?? "http_error");
  }
  return data as T;
}

export const resourceApi = {
  engines: () => get<Engines>("/stack/v1/resources/engines"),
  events: (range: Range) => get<{ range: Range; events: Marker[] }>(`/stack/v1/resources/events?range=${range}`),
  /** Model names in plain words, by model id, from the components list (fetched once). */
  modelNames: async (): Promise<Record<string, string>> => {
    const doc = await get<{ components: { id: string; label: string; kind: string }[] }>("/stack/v1/components");
    return Object.fromEntries(doc.components.filter((c) => c.kind === "model").map((c) => [c.id, c.label]));
  },
};
export type { EngineRow, History };
