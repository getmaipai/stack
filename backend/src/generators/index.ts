// The generator runners the job queue calls, registered once when the
// app loads: the image role's render on the managed ComfyUI. A runner
// gets the role's living process from the supervisor (started and
// admitted like every engine), holds it as a request while the render
// runs, and hands the image back; the queue's own admission covers the
// render's transient set on top.
import { registerJobRunner } from "@/lib/jobs";
import { runOnRole, selectedModel } from "@/lib/supervisor";
import { basename } from "node:path";
import { renderImage, renderMemory } from "@/generators/comfyui";

export function registerGenerators(): void {
  registerJobRunner("image", async (job, signal, progress) => {
    const model = selectedModel("image");
    if (!model?.modelPath) throw new Error("No verified and installed image model is available.");
    progress({ status: "starting the engine" });
    return runOnRole("image", (processRecord) => renderImage(processRecord.client, basename(model.modelPath!), job, signal, progress));
  }, { generator: { role: "image", memory: (job) => renderMemory(job) } });
}
