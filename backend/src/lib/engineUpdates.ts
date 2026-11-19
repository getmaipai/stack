// A newer upstream release of a program the Stack installs (llama.cpp
// first), noticed and kept as one record per program: the installed
// build, the newest tag and the date the Stack first saw that tag. It
// reads public release data only and never downloads anything; the
// install stays an explicit action. The same off switch as the Catalog
// check governs it (`stack.updates.enabled`), a check runs at most once
// every 12 hours unless asked, and a failed read is silent and keeps the
// last record.
import { eq, like } from "drizzle-orm";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { conditionalHeaders, updatesEnabled, type UpdateFetcher } from "@/updates/catalog";
import { currentEngine } from "@/updates/engines";

/** One place for every program with a known upstream, keyed by engine id. `tagPattern` picks the builds the Stack's pins use, so a release named any other way is ignored. */
export const ENGINE_UPSTREAMS: Record<string, { latestReleaseUrl: string; tagPattern: RegExp }> = {
  "llama-server": { latestReleaseUrl: "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest", tagPattern: /^b(\d+)$/ },
};

export const ENGINE_UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const ENGINE_UPDATE_FETCH_TIMEOUT_MS = 10_000;

export interface EngineUpdateRecord { engine: string; installed: string; newest: string; since: string; }

const recordKey = (engine: string) => `engineUpdates.record.${engine}`;
const CHECKED_KEY = "engineUpdates.checked";
const readKey = (key: string) => db.select({ value: meta.value }).from(meta).where(eq(meta.key, key)).get()?.value ?? null;
const writeKey = (key: string, value: string) => db.insert(meta).values({ key, value }).onConflictDoUpdate({ target: meta.key, set: { value } }).run();
const deleteKey = (key: string) => db.delete(meta).where(eq(meta.key, key)).run();

function buildNumber(engine: string, tag: string | null): number | null {
  const match = tag?.match(ENGINE_UPSTREAMS[engine]?.tagPattern ?? /$^/);
  return match ? Number(match[1]) : null;
}

function readRecord(engine: string): EngineUpdateRecord | null {
  const raw = readKey(recordKey(engine));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<EngineUpdateRecord>;
    return typeof parsed.installed === "string" && typeof parsed.newest === "string" && typeof parsed.since === "string" ? { engine, installed: parsed.installed, newest: parsed.newest, since: parsed.since } : null;
  } catch { return null; }
}

/** The kept record for one program, or null. A record whose newest tag is no longer ahead of the installed build (the newer build was installed since) is cleared here, so the listing never shows a stale notice. */
export function engineUpdateRecord(engine: string): EngineUpdateRecord | null {
  const record = readRecord(engine);
  if (!record) return null;
  const installed = buildNumber(engine, currentEngine(engine));
  const newest = buildNumber(engine, record.newest);
  if (installed === null || newest === null || installed >= newest) { deleteKey(recordKey(engine)); return null; }
  return record;
}

/** What the engines listing serves: the newest tag and when it was first noticed, or null. */
export function engineUpdateFor(engine: string): { newest: string; since: string } | null {
  const record = ENGINE_UPSTREAMS[engine] ? engineUpdateRecord(engine) : null;
  return record ? { newest: record.newest, since: record.since } : null;
}

async function newestTag(engine: string, fetcher: UpdateFetcher): Promise<string | null> {
  const upstream = ENGINE_UPSTREAMS[engine]!;
  const response = await fetcher(upstream.latestReleaseUrl, { headers: { accept: "application/vnd.github+json", "user-agent": conditionalHeaders(null)["user-agent"] ?? "maipai-stack" }, signal: AbortSignal.timeout(ENGINE_UPDATE_FETCH_TIMEOUT_MS) });
  if (!response.ok) return null;
  const body = await response.json() as { tag_name?: unknown };
  return typeof body.tag_name === "string" && upstream.tagPattern.test(body.tag_name) ? body.tag_name : null;
}

export interface EngineUpdateCheckOptions { fetcher?: UpdateFetcher; now?: Date; /** Skip the 12-hour throttle: an explicit check. */ force?: boolean; }

/** Reads each upstream's newest release and updates the records. Does nothing (no request) when update checks are off or the last check was under 12 hours ago, unless forced. Never throws. */
export async function checkEngineUpdates(options: EngineUpdateCheckOptions = {}): Promise<void> {
  if (!updatesEnabled()) return;
  const now = options.now ?? new Date();
  const last = Date.parse(readKey(CHECKED_KEY) ?? "");
  if (!options.force && Number.isFinite(last) && now.getTime() - last < ENGINE_UPDATE_CHECK_INTERVAL_MS && now.getTime() >= last) return;
  writeKey(CHECKED_KEY, now.toISOString());
  const fetcher = options.fetcher ?? fetch;
  for (const engine of Object.keys(ENGINE_UPSTREAMS)) {
    try {
      const tag = await newestTag(engine, fetcher);
      if (tag === null) continue;
      const installedTag = currentEngine(engine);
      const installed = buildNumber(engine, installedTag);
      const newest = buildNumber(engine, tag);
      if (installedTag === null || installed === null || newest === null || installed >= newest) { deleteKey(recordKey(engine)); continue; }
      // The same newest tag keeps its first-noticed date; a still newer tag starts a new one.
      const kept = readRecord(engine);
      const since = kept && kept.newest === tag ? kept.since : now.toISOString();
      writeKey(recordKey(engine), JSON.stringify({ installed: installedTag, newest: tag, since }));
    } catch { /* Silent: the last record stays. */ }
  }
}

export function __resetEngineUpdatesForTests(): void { db.delete(meta).where(like(meta.key, "engineUpdates.%")).run(); }
