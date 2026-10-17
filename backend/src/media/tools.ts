// MEDIA-STACK-01: getting the pinned tools onto the machine and finding them.
// ffmpeg and ffprobe come through ensureEngine (the Stack's verified download
// of a pinned archive); yt-dlp through ensureUvEnvironment (the hashed
// requirements file, the same builder as the voice engines and the image
// tools). Both happen the first time a job needs them, inside the job, with
// the phase shown as the job's status. STACK_MEDIA_FFMPEG, STACK_MEDIA_FFPROBE
// and STACK_MEDIA_YTDLP point at binaries the operator or a test already has.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_READY_MARKER } from "@/lib/engineCatalog";
import { engineDir, engineToolPath, ensureEngine } from "@/lib/engineInstall";
import { engineTagRoot } from "@/lib/store/layout";
import { ensureUvEnvironment, uvEnvironmentReady, uvVenvPath, type UvEnvironmentSpec } from "@/lib/uvEnvironment";
import { FFMPEG_NAME, ffmpegPinFor, MEDIA_COMPONENTS, YT_DLP_NAME, YT_DLP_VERSION, ytDlpRequirementsFileFor } from "./pins";

export type MediaTool = "ffmpeg" | "ffprobe" | "yt-dlp";

export class MediaToolError extends Error {
  constructor(readonly code: "tool_unsupported" | "tool_setup_failed", message: string) { super(message); }
}

const override = (tool: MediaTool): string | null => {
  const value = tool === "ffmpeg" ? process.env.STACK_MEDIA_FFMPEG : tool === "ffprobe" ? process.env.STACK_MEDIA_FFPROBE : process.env.STACK_MEDIA_YTDLP;
  return value && value.length > 0 ? value : null;
};

function ytDlpRoot(): string { return engineTagRoot(YT_DLP_NAME, YT_DLP_VERSION); }
export function ytDlpPath(): string { return join(uvVenvPath(ytDlpRoot()), "bin", "yt-dlp"); }
function ytDlpSpec(): UvEnvironmentSpec { return { name: YT_DLP_NAME, version: YT_DLP_VERSION, root: ytDlpRoot(), requirements: ytDlpRequirementsFileFor(), proof: ytDlpPath() }; }

/** The tools a job calls. Tests replace it with a fake that returns scripted paths. */
export interface MediaToolbox {
  /** Installs on first use and returns the executable's path. Throws MediaToolError with words the person can act on. */
  path(tool: MediaTool, onStatus: (status: string) => void, signal?: AbortSignal): Promise<string>;
  installed(tool: MediaTool): boolean;
}

export const defaultToolbox: MediaToolbox = {
  installed(tool) {
    if (override(tool)) return existsSync(override(tool)!);
    if (tool === "yt-dlp") return uvEnvironmentReady({ root: ytDlpRoot(), proof: ytDlpPath(), name: YT_DLP_NAME, version: YT_DLP_VERSION });
    const pin = ffmpegPinFor();
    return !!pin && existsSync(join(engineDir(pin), ENGINE_READY_MARKER)) && existsSync(engineToolPath(pin, tool));
  },
  async path(tool, onStatus, signal) {
    const given = override(tool);
    if (given) { if (!existsSync(given)) throw new MediaToolError("tool_setup_failed", `The ${tool} program named by this computer's settings (${given}) is not there. Fix the setting or remove it.`); return given; }
    if (tool === "yt-dlp") {
      if (!ytDlpRequirementsFileFor()) throw new MediaToolError("tool_unsupported", `Fetching from the web is not available on ${process.platform} ${process.arch} yet.`);
      onStatus("setting up the web fetch tool (first time only)");
      try { await ensureUvEnvironment(ytDlpSpec(), (phase) => onStatus(`setting up the web fetch tool: ${phase}`), { signal }); } catch (error) { throw new MediaToolError("tool_setup_failed", `The web fetch tool could not be set up: ${error instanceof Error ? error.message : String(error)}. Check this computer's internet connection and try again.`); }
      return ytDlpPath();
    }
    const pin = ffmpegPinFor();
    if (!pin) throw new MediaToolError("tool_unsupported", `Video tools are not available on ${process.platform} ${process.arch} yet.`);
    if (!defaultToolbox.installed(tool)) {
      onStatus("downloading the video tools (first time only)");
      try { await ensureEngine(pin, (progress) => onStatus(`downloading the video tools: ${Math.round((progress.completedBytes / Math.max(1, progress.totalBytes)) * 100)}%`), { signal, activate: true }); } catch (error) { throw new MediaToolError("tool_setup_failed", `The video tools could not be downloaded: ${error instanceof Error ? error.message : String(error)}. Check this computer's internet connection and try again.`); }
    }
    return engineToolPath(pin, tool);
  },
};

export function mediaToolsStatus(toolbox: MediaToolbox = defaultToolbox): { supported: boolean; tools: Array<{ name: MediaTool; installed: boolean; version: string; licence: string; source: string }>; platform: string } {
  const supported = !!ffmpegPinFor() && !!ytDlpRequirementsFileFor() || !!override("ffmpeg");
  const tools = (["ffmpeg", "ffprobe", "yt-dlp"] as const).map((name) => {
    const record = MEDIA_COMPONENTS.find((component) => component.name === name)!;
    return { name, installed: toolbox.installed(name), version: record.version, licence: record.licence, source: record.source };
  });
  return { supported, tools, platform: `${process.platform}-${process.arch}` };
}
export { FFMPEG_NAME };
