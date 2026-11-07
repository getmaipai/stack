import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import { MAX_LORA_BYTES, type LoraBase, type LoraClass, getLora, importLora, readLoraHeader, readSafetensorsHeader } from "@/video/loras";
import { LORA_INSTALL_SITES, SITE_RULES, parseInstallUrl, startInstall, sweepParts, type InstallSource, type LoraInstallFailure } from "@/lib/media/loraInstallCore";
import type { Job } from "@/lib/jobs";

export { LORA_INSTALL_SITES, SITE_RULES, parseInstallUrl, type LoraInstallFailure };
export const LORA_INSTALL_KIND = "video.lora.install";
export function sweepInstallParts(now = Date.now()): number {
  return sweepParts(join(dataDir, "tmp", "video-lora-install"), now);
}

export interface VideoLoraInstallInput {
  site: typeof LORA_INSTALL_SITES[number];
  url: string;
  name: string;
  licence: string;
  licenceAcknowledged?: boolean;
  classification?: LoraClass;
  strengthDefault?: number;
  triggerWords?: string[];
  addedBy?: string | null;
  baseModel?: LoraBase | null;
  sha256Expected?: string | null;
  token?: string | null;
  sourceUrl?: string | null;
}

const partDir = () => join(dataDir, "tmp", "video-lora-install");
let installing = false;

export function __resetLoraInstallForTests(): void {
  installing = false;
}

export function startVideoLoraInstall(input: VideoLoraInstallInput, deps: { fetch?: typeof fetch } = {}): Job {
  const source: InstallSource = { ...input };
  return startInstall(source, {
    kind: LORA_INSTALL_KIND,
    role: "video",
    noun: "style",
    partDir,
    parseUrl: parseInstallUrl,
    get: getLora,
    importFile: (options) => importLora(options as unknown as Parameters<typeof importLora>[0]),
    readHeader: (path) => {
      readSafetensorsHeader(path);
      readLoraHeader(path);
    },
    maxBytes: MAX_LORA_BYTES,
  }, () => installing, (id) => {
    installing = id !== null;
  }, deps);
}
