// Decode a media file to 16 kHz mono 16-bit PCM for bumper analysis (streamed from ffmpeg, aborted with the job).
export interface PcmOptions { ffmpegPath?: string; signal?: AbortSignal; sampleRate?: number }

export async function decodePcm16(path: string, opts: PcmOptions = {}): Promise<Int16Array> {
  const rate = opts.sampleRate ?? 16000;
  if (opts.signal?.aborted) throw new Error("Cancelled.");
  const proc = Bun.spawn([opts.ffmpegPath ?? "ffmpeg", "-nostdin", "-v", "error", "-i", path, "-f", "s16le", "-ar", String(rate), "-ac", "1", "-"], { stdout: "pipe", stderr: "pipe" });
  const onAbort = () => { try { proc.kill(); } catch { /* already gone */ } };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const errText = new Response(proc.stderr).text();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) { chunks.push(chunk); total += chunk.length; }
    const code = await proc.exited;
    if (opts.signal?.aborted) throw new Error("Cancelled.");
    if (code !== 0) throw new Error(`ffmpeg could not decode ${path.split("/").pop()} for bumper analysis (exit ${code}): ${(await errText).slice(0, 200)}`);
  } finally { opts.signal?.removeEventListener("abort", onAbort); }
  const bytes = new Uint8Array(total - (total % 2)); let at = 0;
  for (const c of chunks) { const take = Math.min(c.length, bytes.length - at); if (take <= 0) break; bytes.set(c.subarray(0, take), at); at += take; }
  return new Int16Array(bytes.buffer, 0, bytes.length / 2);
}
