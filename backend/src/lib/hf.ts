import { readStackConfig } from "@/settings/stackKeys";

const DEFAULT_ENDPOINT = "https://huggingface.co";

function currentEndpoint(): string {
  const value = readStackConfig().find((setting) => setting.key === "huggingFaceEndpoint")?.inEffect;
  const trimmed = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_ENDPOINT;
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

export function huggingFaceEndpoint(): string {
  return currentEndpoint();
}

export function hfUrl(path: string): string {
  return `${currentEndpoint()}/${path.replace(/^\/+/, "")}`;
}
