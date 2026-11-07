import { createHash } from "node:crypto";
import { join } from "node:path";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { speakRole, speechForm } from "@/lib/supervisor";
import type { Job, JobProgress } from "@/lib/jobs";
import { jobDir, resolveWritableDir } from "./paths";

export const TtsBatchInput = z.object({ lines: z.array(z.object({ id: z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/), text: z.string().min(1).max(4000), voice_url: z.string().optional(), temperature: z.number().optional(), pitch_semitones: z.number().min(-12).max(12).optional() }).strict()).min(1).max(400), output: z.object({ dir: z.string().optional() }).default({}) }).strict();
function wavDuration(bytes: Uint8Array): number {
  if (bytes.length < 44 || String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" || String.fromCharCode(...bytes.slice(8, 12)) !== "WAVE") throw new Error("The speech engine returned an invalid WAV file. Try again or change the voice.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let rate = 0; let data = 0;
  for (let at = 12; at + 8 <= bytes.length;) { const tag = String.fromCharCode(...bytes.slice(at, at + 4)); const size = view.getUint32(at + 4, true); if (tag === "fmt " && size >= 16) rate = view.getUint32(at + 16, true); if (tag === "data") data = size; at += 8 + size + (size & 1); }
  if (!rate || !data) throw new Error("The speech engine returned a WAV file without duration data. Try again or change the voice."); return data / rate;
}
export async function runTtsBatch(job: Job, signal: AbortSignal, progress: JobProgress) {
  const input = TtsBatchInput.parse(job.input ?? {}); const dir = input.output.dir ? resolveWritableDir(input.output.dir) : jobDir(job.id); const lines = [];
  for (let i = 0; i < input.lines.length; i++) {
    if (signal.aborted) throw new Error("The speech batch was cancelled. Submit it again.");
    const line = input.lines[i]!; const part = join(dir, `${line.id}.wav.part`); const target = join(dir, `${line.id}.wav`);
    try {
      const reply = await speakRole("tts", speechForm(line.text, line.voice_url, { temperature: line.temperature, pitch_semitones: line.pitch_semitones }), signal);
      if (reply.status < 200 || reply.status >= 300 || !reply.body) throw new Error(`The speech engine returned HTTP ${reply.status}.`);
      const bytes = new Uint8Array(await new Response(reply.body).arrayBuffer()); const duration_s = wavDuration(bytes); writeFileSync(part, bytes, { mode: 0o600 }); renameSync(part, target);
      lines.push({ id: line.id, path: target, duration_s, sha256: createHash("sha256").update(bytes).digest("hex") });
    } catch (error) { rmSync(part, { force: true }); const message = error instanceof Error ? error.message : "the engine did not provide an explanation"; throw new Error(`Line ${line.id} could not be spoken: ${message}. Try again or change the voice.`); }
    progress({ percent: Math.round((i + 1) / input.lines.length * 100), status: `spoken ${i + 1} of ${input.lines.length} lines` });
  }
  return { lines };
}
