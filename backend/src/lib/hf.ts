import { settingValues } from "@/settings";
import { listFiles, modelInfo } from "@huggingface/hub";

const DEFAULT_ENDPOINT = "https://huggingface.co";

function currentEndpoint(): string {
  const value = settingValues()["stack.updates.model_host"];
  const trimmed = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_ENDPOINT;
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

export function huggingFaceEndpoint(): string {
  return currentEndpoint();
}

export function hfUrl(path: string): string {
  return `${currentEndpoint()}/${path.replace(/^\/+/, "")}`;
}

export interface HfFile { name: string; sizeBytes: number | null; sha256: string | null; url: string; }
export interface HfResolution { repo: string; name: string; revision: string; licence: string | null; gated: boolean; files: HfFile[]; role: "chat" | "image" | "unknown"; }

type HfFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
let fetchForTests: HfFetch | null = null;
function hubFetch(): HfFetch { return fetchForTests ?? fetch; }
function valueAt(value: unknown, key: string): unknown { return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined; }
function licenceFrom(value: unknown): string | null {
  const cardLicence = valueAt(value, "license");
  if (typeof cardLicence === "string" && cardLicence) return cardLicence;
  const tags = valueAt(value, "tags");
  if (Array.isArray(tags)) {
    const tag = tags.find((item) => typeof item === "string" && item.startsWith("license:"));
    if (typeof tag === "string") return tag.slice("license:".length);
  }
  return null;
}
function roleFrom(info: { task?: string; config?: unknown; cardData?: unknown }, files: HfFile[]): HfResolution["role"] {
  if (info.task === "text-to-image") return "image";
  if (info.task === "text-generation") return "chat";
  const template = valueAt(info.config, "chat_template") ?? valueAt(info.cardData, "chat_template");
  return files.some((file) => file.name.toLowerCase().endsWith(".gguf")) && typeof template === "string" && template.length > 0 ? "chat" : "unknown";
}

export async function resolveHuggingFace(repo: string): Promise<HfResolution> {
  const info = await modelInfo({ name: repo, hubUrl: currentEndpoint(), fetch: hubFetch() as typeof fetch, additionalFields: ["sha", "cardData", "config", "tags"] });
  const revision = info.sha;
  const files: HfFile[] = [];
  for await (const file of listFiles({ repo: { type: "model", name: repo }, revision, recursive: true, hubUrl: currentEndpoint(), fetch: hubFetch() as typeof fetch })) {
    if (file.type === "file") files.push({ name: file.path, sizeBytes: file.lfs?.size ?? file.size ?? null, sha256: file.lfs?.oid ?? null, url: hfUrl(`${repo}/resolve/${revision}/${file.path}`) });
  }
  return { repo, name: info.name, revision, licence: licenceFrom(info.cardData) ?? licenceFrom(info), gated: info.gated !== false, files, role: roleFrom(info, files) };
}

export function __setHuggingFaceFetchForTests(value: HfFetch | null): void { fetchForTests = value; }
