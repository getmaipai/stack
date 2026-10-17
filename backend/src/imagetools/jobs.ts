// The job runner behind POST /v1/images/edits (IMAGETOOLS-01). The picture
// itself never rides on the job record (which Home lists and the event feed
// carries): the route stashes the bytes under a token, the runner takes
// them, and the result waits in the service's short in-memory keep.
import { registerJobRunner } from "@/lib/jobs";
import { ImageToolError, imageTools, keepResult, unstashInput } from "./imageTools";

export interface ImageEditResult { images?: Array<{ result_id: string; width: number; height: number; content_type: "image/png"; operation: string; engine: string; model: string; ms: number }>; rejected?: { code: string; message: string; status: number }; }

export function registerImageToolJobs(): void {
  registerJobRunner("image_edit", async (job, signal, progress): Promise<ImageEditResult> => {
    const token = String((job.input as { token?: string } | null)?.token ?? "");
    const input = unstashInput(token);
    if (!input) return { rejected: { code: "failed", message: "The picture was not received. Send it again.", status: 400 } };
    try {
      const result = await imageTools.run(input, { signal, onStatus: (status) => progress({ status }) });
      keepResult(job.id, result);
      return { images: [{ result_id: job.id, width: result.width, height: result.height, content_type: "image/png", operation: result.operation, engine: result.engine, model: result.model, ms: result.ms }] };
    } catch (error) {
      if (signal.aborted) throw error;
      // A refusal the person can act on is the job's answer, not a Stack failure.
      if (error instanceof ImageToolError) return { rejected: { code: error.code, message: error.message, status: error.status } };
      throw error;
    }
  });
}
