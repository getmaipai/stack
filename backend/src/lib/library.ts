import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import { listModels, type ModelRecord } from "@/lib/modelStore";
import { getModelUsage } from "@/lib/modelGroups";
import { ENGINE_BINARIES, ENGINE_READY_MARKER, installedEnginePin, type EngineBinaryPin } from "@/lib/engineCatalog";
import { engineDir } from "@/lib/engineInstall";
import { updatesEnabled } from "@/updates/check";

export type LibraryKind = "model" | "engine";
export interface LibraryItem { id: string; kind: LibraryKind; title: string; source: string; licence: string; fetchedAt: string; revision: string; size: number; etag: string | null; }
export interface LibraryPage extends LibraryItem { markdown: string; files: string[]; numbers: { footprintBytes: number | null; speedTokensPerSecond: number | null; lastUsedAt: string | null }; }
export type LibraryFetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
export const LIBRARY_FETCH_JOB_KIND = "library.fetch";

let root = join(dataDir, "library");
let pageRoot = join(root, ".pages");
let pagefindRoot = join(root, ".pagefind");
let modelOverride: ModelRecord[] | null = null;
let updatesOverride: boolean | null = null;
const version = "0.1.0";
function safe(id: string): string { return id.replace(/[^a-zA-Z0-9._-]+/g, "_"); }
function itemDir(id: string): string { return join(root, safe(id)); }
export function libraryLocation(id: string): string { return itemDir(id); }
function metaPath(id: string): string { return join(itemDir(id), "meta.json"); }
function readMeta(id: string): LibraryItem | null { try { return JSON.parse(readFileSync(metaPath(id), "utf8")) as LibraryItem; } catch { return null; } }
function writeMeta(item: LibraryItem): void { mkdirSync(itemDir(item.id), { recursive: true, mode: 0o700 }); writeFileSync(metaPath(item.id), JSON.stringify(item, null, 2), { mode: 0o600 }); }
function markdownPath(id: string): string { return join(itemDir(id), "README.md"); }
function titleForModel(model: ModelRecord): string { return model.nickname ?? model.id; }
function modelRepo(model: ModelRecord): string | null { return typeof model.provenance.repo === "string" ? model.provenance.repo : null; }
function modelSource(model: ModelRecord, repo: string): string { return `https://huggingface.co/${repo}/tree/${model.revision}`; }
function headers(etag: string | null): RequestInit["headers"] { return { "if-none-match": etag ?? "", "user-agent": `maipai-stack/${version} (${process.platform}-${process.arch})` }; }
function filesFor(id: string): string[] { try { return readdirSync(itemDir(id)).filter((file) => file !== "meta.json"); } catch { return []; } }
function sizeFor(id: string): number { return filesFor(id).reduce((total, file) => { try { return total + statSync(join(itemDir(id), file)).size; } catch { return total; } }, 0); }
function htmlEscape(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function rebuildLibraryIndex(): void {
  mkdirSync(pageRoot, { recursive: true, mode: 0o700 });
  for (const item of listLibrary()) {
    const markdown = readFileSync(markdownPath(item.id), "utf8");
    writeFileSync(join(pageRoot, `${safe(item.id)}.html`), `<!doctype html><html><head><title>${htmlEscape(item.title)}</title></head><body><main data-pagefind-body><h1>${htmlEscape(item.title)}</h1><p>${htmlEscape(item.source)} · ${htmlEscape(item.licence)}</p><pre>${htmlEscape(markdown)}</pre></main></body></html>`, { mode: 0o600 });
  }
  writeFileSync(join(root, "index.json"), JSON.stringify(listLibrary()), { mode: 0o600 });
  const pagefind = Bun.which("pagefind") ?? join(import.meta.dir, "../../../node_modules/pagefind/lib/runner/bin.cjs");
  if (!existsSync(pagefind)) return;
  try {
    const result = Bun.spawnSync([process.execPath, pagefind, "--site", root, "--output-path", pagefindRoot, "--glob", ".pages/*.html"], { stdout: "ignore", stderr: "ignore" });
    if (result.exitCode !== 0) rmSync(pagefindRoot, { recursive: true, force: true });
  } catch { /* JSON search remains available when the optional CLI is unavailable. */ }
}

function modelPage(model: ModelRecord): { id: string; url: string; source: string; licence: string; revision: string; title: string } | null {
  const repo = modelRepo(model); if (!repo) return null;
  return { id: `model-${model.id}`, url: `https://huggingface.co/${repo}/resolve/${model.revision}/README.md`, source: modelSource(model, repo), licence: model.licence ?? String(model.provenance.licence ?? "Unknown"), revision: model.revision, title: titleForModel(model) };
}
function enginePage(pin: EngineBinaryPin): { id: string; url: string; source: string; licence: string; revision: string; title: string } { const docsUrl = pin.docsUrl ?? `https://github.com/ggml-org/llama.cpp/tree/${pin.id}/docs`; return { id: `engine-${safe(pin.id)}`, url: docsUrl, source: docsUrl, licence: "MIT", revision: pin.id, title: pin.label }; }
function installedEngines(): EngineBinaryPin[] { return ENGINE_BINARIES.filter((pin) => existsSync(join(engineDir(pin.id), ENGINE_READY_MARKER))); }

export function listLibrary(): LibraryItem[] { if (!existsSync(root)) return []; return readdirSync(root).map((id) => readMeta(id)).filter((item): item is LibraryItem => item !== null).sort((a, b) => a.title.localeCompare(b.title)); }
export function getLibraryPage(id: string): LibraryPage | null {
  const item = readMeta(id); if (!item) return null;
  const model = id.startsWith("model-") ? (modelOverride ?? listModels()).find((entry) => `model-${entry.id}` === id) : null;
  const usage = model ? getModelUsage(model.id) : null;
  return { ...item, markdown: readFileSync(markdownPath(id), "utf8"), files: filesFor(id), numbers: { footprintBytes: model?.measuredFootprintBytes ?? null, speedTokensPerSecond: null, lastUsedAt: usage?.lastUsedAt ?? null } };
}
export function searchLibrary(query: string): Array<LibraryItem & { snippet: string }> { const needle = query.trim().toLocaleLowerCase(); return listLibrary().flatMap((item) => { const markdown = readFileSync(markdownPath(item.id), "utf8"); if (!needle || `${item.title} ${item.source} ${markdown}`.toLocaleLowerCase().includes(needle)) return [{ ...item, snippet: markdown.slice(0, 180).replaceAll("\n", " ") }]; return []; }); }

async function fetchOne(page: ReturnType<typeof modelPage> | ReturnType<typeof enginePage>, fetcher: LibraryFetcher): Promise<boolean> {
  if (!page) return false;
  const old = readMeta(page.id);
  if (old?.revision === page.revision && existsSync(markdownPath(page.id))) return false;
  const response = await fetcher(page.url, { headers: headers(old?.revision === page.revision ? old.etag ?? null : null) });
  if (response.status === 304 && old) return false;
  if (!response.ok) throw new Error(`Library fetch returned HTTP ${response.status}.`);
  mkdirSync(itemDir(page.id), { recursive: true, mode: 0o700 });
  writeFileSync(markdownPath(page.id), await response.text(), { mode: 0o600 });
  writeMeta({ id: page.id, kind: page.id.startsWith("model-") ? "model" : "engine", title: page.title, source: page.source, licence: page.licence, fetchedAt: new Date().toISOString(), revision: page.revision, size: 0, etag: response.headers.get("etag") });
  const item = readMeta(page.id); if (item) { item.size = sizeFor(page.id); writeMeta(item); }
  return true;
}

export async function fetchLibrary(fetcher: LibraryFetcher = fetch): Promise<{ fetched: number; skipped: boolean }> {
  if (!(updatesOverride ?? updatesEnabled())) return { fetched: 0, skipped: true };
  let fetched = 0;
  for (const model of (modelOverride ?? listModels()).filter((entry) => entry.modelPath)) { const page = modelPage(model); if (page && await fetchOne(page, fetcher)) fetched++; }
  for (const pin of installedEngines()) if (await fetchOne(enginePage(pin), fetcher)) fetched++;
  rebuildLibraryIndex();
  return { fetched, skipped: false };
}

export function __setLibraryRootForTests(directory: string): void { root = directory; pageRoot = join(root, ".pages"); pagefindRoot = join(root, ".pagefind"); }
export function __setLibraryModelsForTests(models: ModelRecord[] | null): void { modelOverride = models; }
export function __setLibraryUpdatesForTests(enabled: boolean | null): void { updatesOverride = enabled; }
export function __resetLibraryForTests(): void { rmSync(root, { recursive: true, force: true }); }
