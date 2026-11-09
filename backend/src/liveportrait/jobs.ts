// The job runner behind POST /v1/images/talk-frames (TALK-06). The picture
// never rides on the job record (which Home lists and the event feed
// carries): the route stashes the bytes under a token, the runner takes them,
// and the frames wait in the service's short in-memory keep.
import { registerJobRunner } from "@/lib/jobs";
import { keepTalkResult, livePortrait, LivePortraitError, unstashTalkInput } from "./liveportrait";

export interface TalkFramesJobResult {
  /** Counts and sizes only: the ratios and the frames stay in the service's short in-memory keep, never on the job record. */
  frameCount?: number;
  width?: number;
  height?: number;
  /** Worker time for the whole request, milliseconds. */
  ms?: number;
  sourceEye?: number;
  sourceLip?: number;
  rejected?: { code: string; message: string; status: number };
}

export function registerTalkFrameJobs(): void {
  registerJobRunner("talk_frames", async (job, signal, progress): Promise<TalkFramesJobResult> => {
    const token = String((job.input as { token?: string } | null)?.token ?? "");
    const input = unstashTalkInput(token);
    if (!input) return { rejected: { code: "failed", message: "The picture was not received. Send it again.", status: 400 } };
    try {
      const result = await livePortrait.run(input, { signal, onStatus: (status) => progress({ status }) });
      keepTalkResult(job.id, result);
      return { sourceEye: result.sourceEye, sourceLip: result.sourceLip, frameCount: result.frames.length, width: result.width, height: result.height, ms: result.ms };
    } catch (error) {
      if (signal.aborted) throw error;
      // A refusal the person can act on is the job's answer, not a Stack failure.
      if (error instanceof LivePortraitError) return { rejected: { code: error.code, message: error.message, status: error.status } };
      throw error;
    }
  });
}
