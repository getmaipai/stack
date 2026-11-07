import { describe, expect, it, mock } from "bun:test";
import { runTtsBatch } from "./tts";

const wav = () => { const bytes = new Uint8Array(44 + 8000); const v = new DataView(bytes.buffer); bytes.set(new TextEncoder().encode("RIFF"), 0); v.setUint32(4, bytes.length - 8, true); bytes.set(new TextEncoder().encode("WAVEfmt "), 8); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); bytes.set(new TextEncoder().encode("data"), 36); v.setUint32(40, 8000, true); return bytes; };
describe("media.tts", () => it("writes three WAVs in input order", async () => {
  const mod = await import("@/lib/supervisor"); const original = mod.speakRole;
  mock.module("@/lib/supervisor", () => ({ ...mod, speakRole: async () => ({ status: 200, body: new ReadableStream({ start(c) { c.enqueue(wav()); c.close(); } }) }) }));
  try { const result = await runTtsBatch({ id: "test-tts", input: { lines: [{ id: "one", text: "one" }, { id: "two", text: "two" }, { id: "three", text: "three" }] } } as never, new AbortController().signal, () => {}); expect(result.lines.map((x) => x.id)).toEqual(["one", "two", "three"]); expect(result.lines.every((x) => x.duration_s > 0)).toBe(true); expect(result.lines.every((x) => Bun.file(x.path).size > 0)).toBe(true); } finally { void original; }
}));
