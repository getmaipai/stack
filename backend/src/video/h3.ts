// H3-VIDEO-STACK-01: CLI adapter for the yshenaw MLX port. Weight pins are
// intentionally absent until exact file revisions and hashes are recorded.
export const H3_VIDEO_ID = "minimax-h3";
export const H3_VIDEO_ENGINE = "minimax-h3-video-gen";
export const H3_VIDEO_VERSION = "55bb7dd";
export const H3_VIDEO_CAPABILITIES = {
  first_picture: false, last_picture: false, reference_pictures: false,
  extend: false, audio: true, lora: true,
} as const;
export const H3_VIDEO_LICENSE = "MiniMax H3 Community License";
export const H3_VIDEO_LICENSE_NOTICE = {
  id: "minimax-h3-community-2026-08-02",
  name: "MiniMax H3 Community License Agreement",
  url: "https://huggingface.co/MiniMaxAI/MiniMax-H3",
  summary: ["MiniMax H3 is downloaded from the maker's published files for household use.", "The licence includes territory restrictions and an authorisation requirement above US$20M revenue. Read it before accepting."],
};

export type H3VideoBuild = "boost-8bit" | "streaming-24gb";
export interface H3VideoCommandInput {
  prompt: string; build: H3VideoBuild; checkpoint: string; transformer: string;
  qwenDir: string; output: string; seconds: number; width: number; height: number;
  seed: number; steps: number; lora?: string;
}
export function h3VideoCommand(python: string, script: string, input: H3VideoCommandInput): string[] {
  return [python, script, input.prompt, "--checkpoint", input.checkpoint,
    "--transformer", input.transformer, "--qwen-dir", input.qwenDir,
    "--qwen-stages", "2", ...(input.lora ? ["--lora", input.lora] : []),
    "--steps", String(input.steps), "--duration", String(input.seconds),
    "--width", String(input.width), "--height", String(input.height),
    "--seed", String(input.seed), "--output", input.output];
}

/** One seam for the existing frame-by-frame media upscale operation. */
export async function finishH3Clip(upscale: (clip: string) => Promise<void>, clip: string): Promise<void> {
  await upscale(clip);
}
