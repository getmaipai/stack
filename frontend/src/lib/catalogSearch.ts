// The catalog and Hugging Face search/resolve calls, shared by AddSheet
// and the Models browser's Browse tab so neither hand-rolls its own copy.

export interface CatalogEntry {
  id: string;
  name: string;
  kind: "model" | "engine";
  roles?: string[];
  licence: string | null;
  licenceSentence?: string;
  licenceFlag?: string;
  licenceUrl?: string | null;
  sizeBytes: number | null;
  source: string;
  revision: string | null;
  url: string | null;
  sha256: string | null;
  repo: string | null;
  runsOnThisComputer?: boolean;
  files?: Array<{ name: string; sizeBytes: number | null; sha256: string | null; url: string }>;
}

export async function searchCatalog(kind: "model" | "engine", query: string): Promise<CatalogEntry[]> {
  const response = await fetch(`/stack/v1/catalog/search?kind=${kind}&q=${encodeURIComponent(query)}`);
  if (!response.ok) return [];
  return (await response.json() as { results: CatalogEntry[] }).results;
}

export async function searchHuggingFace(query: string): Promise<{ enabled?: boolean; results: CatalogEntry[] }> {
  // No request for an empty query, and no `enabled` value either: the
  // caller hasn't learned anything new about the feature flag, so it
  // must leave whatever it last knew alone rather than assume "on".
  if (!query.trim()) return { results: [] };
  const response = await fetch(`/stack/v1/catalog/search?kind=huggingface&q=${encodeURIComponent(query)}`);
  if (!response.ok) return { results: [] };
  return await response.json() as { enabled: boolean; results: CatalogEntry[] };
}

export async function resolveHuggingFace(repo: string): Promise<CatalogEntry | null> {
  const response = await fetch(`/stack/v1/catalog/huggingface/resolve?repo=${encodeURIComponent(repo)}`);
  if (!response.ok) return null;
  return (await response.json() as { result: CatalogEntry }).result;
}

export async function installFromCatalog(entry: CatalogEntry, source: "catalog" | "huggingface"): Promise<void> {
  await fetch("/stack/v1/models", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: entry.id, source, roles: entry.roles ?? ["chat"], url: entry.url, sha256: entry.sha256, licence: entry.licence, revision: entry.revision }) });
}
