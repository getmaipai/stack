import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { getModel } from "@/lib/modelStore";
import { STACK_DEREVERB_MODEL_ID } from "@/lib/modelCatalog";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heavyGate } from "@/lib/heavyGate";
import { getGovernorStatus } from "@/lib/governor";
import { ensureMlxAudioEnvironment, mlxAudioPython } from "@/speech/mlxAudio";
import worker from "@/speech/dereverb_worker.py" with { type: "file" };

const ErrorSchema = z.object({ error: z.string(), code: z.string().optional() });
const route = createRoute({ method: "post", path: "/", tags: ["Roles"], summary: "Remove echo and noise from speech", request: { body: { content: { "application/json": { schema: z.object({ audio_base64: z.string() }) }, "audio/wav": { schema: z.any() }, "multipart/form-data": { schema: z.any() } } } }, responses: { 200: { content: { "audio/wav": { schema: z.any() } }, description: "Cleaned 48 kHz mono WAV, retaining the clip duration." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Send a valid WAV clip." }, 413: { content: { "application/json": { schema: ErrorSchema } }, description: "Clip exceeds 20 MB or 60 seconds." }, 503: { content: { "application/json": { schema: ErrorSchema } }, description: "Install the speech enhancement model from Home's Engines page." } } });
export const audioEnhanceRoutes = apiRouter<AppEnv>();
audioEnhanceRoutes.openapi(route, async (c) => {
  let bytes: Uint8Array;
  const ct = c.req.header("content-type") ?? "";
  if (ct.includes("application/json")) { const body = await c.req.json().catch(() => null) as any; try { bytes = Buffer.from(body?.audio_base64 ?? "", "base64"); } catch { bytes = new Uint8Array(); } }
  else if (ct.includes("multipart/form-data")) { const form = await c.req.formData().catch(() => null); const file = form?.get("file"); bytes = file instanceof Blob ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array(); }
  else bytes = new Uint8Array(await c.req.arrayBuffer());
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) return c.json({ error: "Send a WAV clip no larger than 20 MB." }, bytes.length ? 413 : 400);
  if (String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" || String.fromCharCode(...bytes.slice(8, 12)) !== "WAVE") return c.json({ error: "The audio is not a WAV file. Send a PCM WAV clip." }, 400);
  const sampleRate = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(24, true);
  const byteRate = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(28, true);
  if (!sampleRate || !byteRate || (bytes.length - 44) / byteRate > 60) return c.json({ error: "The WAV clip is longer than 60 seconds. Trim it and try again." }, 413);
  const model = getModel(STACK_DEREVERB_MODEL_ID);
  if (!model?.modelPath || !model.verifiedAt || !existsSync(join(model.modelPath, "model_fp16.safetensors"))) return c.json({ error: "Speech enhancement is not installed. Install MossFormer2 SE from Home's Engines page, then try again.", code: "not_installed" }, 503);
  const status = getGovernorStatus();
  const resident = status.loaded.filter((item) => item.kind === "resident").reduce((sum, item) => sum + item.peakBytes, 0);
  if (resident + 3_000_000_000 > status.capBytes) return c.json({ error: "There is not enough memory for speech enhancement right now. Close another large task, then try again.", code: "no_memory" }, 503);
  const end = heavyGate.begin("tts");
  const dir = mkdtempSync(join(tmpdir(), "stack-enhance-"));
  try {
    await ensureMlxAudioEnvironment(() => {}, { signal: c.req.raw.signal });
    const source = join(dir, "input.wav"), target = join(dir, "output.wav"), script = join(dir, "worker.py"); writeFileSync(source, bytes); writeFileSync(script, await Bun.file(worker).text());
    const child = Bun.spawn([mlxAudioPython(), "-s", script, model.modelPath, source, target], { stdout: "ignore", stderr: "ignore", env: { ...process.env, HF_HUB_OFFLINE: "1" } });
    const code = await child.exited;
    if (code !== 0 || !existsSync(target)) return c.json({ error: "Speech enhancement failed. Check the WAV file and try again." }, 500);
    return c.body(readFileSync(target), 200, { "Content-Type": "audio/wav" });
  } finally { end(); rmSync(dir, { recursive: true, force: true }); }
});
