// VF-RECEIPT-01: what the runner does after the model has written its file. The model's own file is kept (`native.mp4`) and never rewritten;
// a finish (H3's sharpening and enlarging) works on a copy of it and its result becomes the delivered `video.mp4` that Home downloads today;
// a failed finish leaves the native file as the delivered one. Both files are probed, and the poster is cut again from the delivered file when
// the finish changed its size. Pulled out of the job runner so it can be tested without a model.
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { probeReceiptFile, reportedFile, type ReceiptFile } from "./receipt";
import { RecipeFinishFailure, type AppliedFinish } from "./recipeFinish";
import type { StackVideoReceipt } from "@maipai/spec/stack/ts/stack-video-receipt.js";

export interface DeliverInput {
  outputDir: string;
  /** What the generator said it made: the fallback when a file cannot be probed. */
  reported: { width: number; height: number; frames: number; fps: number; audio: boolean };
  /** The generator already set the native file aside and made a messaging-ready `video.mp4` from it. */
  derivedByGenerator: boolean;
  /** The recipe's finish: works on the file at the path it is given, in place, and says what each step did. Null when the recipe has none. */
  finish: ((path: string) => Promise<readonly AppliedFinish[]>) | null;
  /** Cuts the poster from the delivered file. Called only after a finish that worked. */
  recutPoster: (video: string, poster: string) => Promise<void>;
  signal?: AbortSignal;
}
export interface Delivered {
  native: ReceiptFile; delivered: ReceiptFile; keptNative: boolean;
  deliveredIs: StackVideoReceipt["delivered_is"];
  finish: StackVideoReceipt["finish"];
}

export async function deliverClip(input: DeliverInput): Promise<Delivered> {
  const video = join(input.outputDir, "video.mp4");
  const native = join(input.outputDir, "native.mp4");
  let finished: "ok" | "failed" | null = null;
  let applied: readonly AppliedFinish[] = [];
  let failedStep: string | null = null;
  if (input.finish) {
    copyFileSync(video, native);
    try { applied = await input.finish(video); finished = applied.some((step) => step.ok) ? "ok" : "failed"; if (finished === "failed") failedStep = applied.find((step) => !step.ok)?.operation ?? "finish"; }
    catch (error) {
      if (input.signal?.aborted) throw error;
      finished = "failed";
      if (error instanceof RecipeFinishFailure) { applied = error.applied; failedStep = error.operation; } else failedStep = "finish";
    }
  }
  if (finished === "ok") { try { await input.recutPoster(video, join(input.outputDir, "poster.jpg")); } catch { /* the first cut stays */ } }
  const keptNative = existsSync(native);
  const nativeFile = (await probeReceiptFile(keptNative ? native : video, input.signal)) ?? reportedFile(keptNative ? native : video, input.reported);
  const deliveredFile = keptNative ? ((await probeReceiptFile(video, input.signal)) ?? reportedFile(video, input.reported)) : nativeFile;
  const deliveredIs: Delivered["deliveredIs"] = finished === "ok" ? "finished" : input.derivedByGenerator ? "messaging_copy" : "native";
  const finish: Delivered["finish"] = [];
  const size = (file: ReceiptFile) => ({ width: file.width, height: file.height });
  for (const step of applied) finish.push({ operation: step.operation, from: step.from, to: step.to, ok: step.ok, code: step.code });
  if (finished === "failed" && failedStep && !applied.some((step) => step.operation === failedStep && !step.ok)) finish.push({ operation: failedStep, from: size(nativeFile), to: size(deliveredFile), ok: false, code: "finish_failed" });
  if (input.derivedByGenerator) finish.push({ operation: "messaging_copy", from: size(nativeFile), to: size(deliveredFile), ok: true, code: null });
  return { native: nativeFile, delivered: deliveredFile, keptNative, deliveredIs, finish };
}
