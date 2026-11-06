import { expect, spyOn, test } from "bun:test";
import { handle } from "@/recordedSpeech/recordedSpeech";
import * as stackLog from "@/lib/log";

test("a failed render logs the worker traceback tail without request data", async () => {
  const logSpy = spyOn(stackLog, "log").mockImplementation(() => {});
  const enc = new TextEncoder(); let out!: ReadableStreamDefaultController<Uint8Array>; let err!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({ start(c) { out = c; } }), stderr = new ReadableStream<Uint8Array>({ start(c) { err = c; } });
  const worker = handle({ stdin: { write() {}, flush() {} }, stdout, stderr, exited: new Promise<number>(() => {}), kill() {} });
  out.enqueue(enc.encode('{"ready":true}\n'));
  const sent = worker.send({ id: "trace-id", text: "private request", references: [], format: "wav", output: "/private/out.wav", outputWav: "/private/out.wav", work_dir: "/private/work", model: "/private/model" }, () => {});
  await new Promise((r) => setTimeout(r, 50));
  err.enqueue(enc.encode("Traceback (most recent call last):\nRuntimeError: fixture failure\n"));
  await new Promise((r) => setTimeout(r, 50));
  out.enqueue(enc.encode('{"id":"trace-id","ok":false,"error":"failed"}\n'));
  await expect(sent).rejects.toThrow();
  const logged = logSpy.mock.calls.map(([line]) => String(line)).join("\n");
  expect(logged).toContain("recorded-speech.worker_error");
  expect(logged).toContain("RuntimeError: fixture failure");
  expect(logged).not.toContain("private request");
  logSpy.mockRestore();
});
