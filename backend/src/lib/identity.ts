import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ENGINE_BINARIES, ENGINE_READY_MARKER } from "@/lib/engineCatalog";
import { engineTagRoot } from "@/lib/store/layout";

/** The three headers on every reply (spec RoleReplyHeaders): the engine
 * host and build that answered, the model file, and the model's pinned
 * revision when the process knows its model record (the engine build
 * otherwise); `none` for each when nothing answered. */
export function identityHeaders(identity: EngineIdentity | null, modelRevision: string | null = null): Record<string, string> {
  if (!identity) return { "x-maipai-engine": "none", "x-maipai-model": "none", "x-maipai-revision": "none" };
  return {
    "x-maipai-engine": [identity.host, identity.build].filter((part): part is string => !!part).join(" ") || "none",
    "x-maipai-model": identity.model ?? "none",
    "x-maipai-revision": modelRevision ?? identity.build ?? "none",
  };
}

export type EngineHost = "local" | "external" | "stub";

export interface EngineIdentity {
  host: EngineHost;
  build: string | null;
  model: string | null;
  healthy: boolean | null;
}

const LOOPBACK_RE = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1|0\.0\.0\.0)$/i;

export function hostLabel(url: string): "local" | "external" {
  try {
    return LOOPBACK_RE.test(new URL(url).hostname) ? "local" : "external";
  } catch {
    return "external";
  }
}

export function sanitizeEngineUrl(url: string | undefined): string {
  if (!url) return "n/a";
  return hostLabel(url) === "local" ? url : "external";
}

interface Props {
  build_info?: unknown;
  model_path?: unknown;
}

export function modelFileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export async function readEngineIdentity(url: string, timeoutMs = 3_000, healthPath = "/health"): Promise<EngineIdentity> {
  const base = url.replace(/\/$/, "");
  const [healthy, props] = await Promise.all([
    // llama-server and the speech worker say `ok`; Pocket TTS says
    // `healthy`; an engine with a different liveness route (ComfyUI's
    // /system_stats) is alive on any 2xx there.
    fetch(`${base}${healthPath}`, { signal: AbortSignal.timeout(timeoutMs) })
      .then(async (res) => { if (!res.ok) return false; if (healthPath !== "/health") return true; const status = ((await res.json()) as { status?: string }).status; return status === "ok" || status === "healthy"; })
      .catch(() => false),
    fetch(`${base}/props`, { signal: AbortSignal.timeout(timeoutMs) })
      .then(async (res) => (res.ok ? ((await res.json()) as Props) : {}))
      .catch((): Props => ({})),
  ]);
  const build = typeof props.build_info === "string" && props.build_info ? props.build_info : null;
  const model = typeof props.model_path === "string" && props.model_path ? modelFileName(props.model_path) : null;
  return { host: hostLabel(url), build, model, healthy };
}

export function formatEngineIdentity(identity: EngineIdentity | null | undefined): string {
  if (!identity) return "none";
  return [identity.host, identity.build, identity.model].filter((part): part is string => !!part).join(" ");
}

export function identityIncomplete(identity: EngineIdentity): boolean {
  return identity.build === null && identity.model === null;
}

export function installedEngineForMachine(name = "llama-server"): boolean {
  const pin = ENGINE_BINARIES.find((entry) => entry.name === name && entry.platform === process.platform && entry.arch === process.arch && !entry.requiresNvidia);
  return pin ? existsSync(join(engineTagRoot(pin.name, pin.tag), ENGINE_READY_MARKER)) : false;
}
