import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useStackChat } from "@/lib/useStackChat";

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

function Harness() {
  const chat = useStackChat();
  return <div><button onClick={() => void chat.send("Say hello")}>send</button><button onClick={chat.stop}>stop</button><output>{chat.messages.map((message) => `${message.role}:${message.content}:${message.metrics?.engine ?? ""}:${message.metrics?.model ?? ""}:${message.metrics?.firstTokenMs ?? ""}:${message.metrics?.tokensPerSecond ?? ""}`).join("|")}</output><span>{chat.status}</span></div>;
}

function streamResponse(chunks: string[], signal?: AbortSignal): Response {
  const encoder = new TextEncoder(); let index = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { if (signal?.aborted) { controller.error(new DOMException("Aborted", "AbortError")); return; } if (index >= chunks.length) { controller.close(); return; } controller.enqueue(encoder.encode(chunks[index++])); } });
  return new Response(body, { headers: { "content-type": "text/event-stream", "x-maipai-engine": "local", "x-maipai-model": "qwen3-1.7b" } });
}

test("streams ordered deltas and exposes the identity metrics line", async () => {
  globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(streamResponse([
    'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"from "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Stack."}}]}\n\ndata: [DONE]\n\n',
  ], init?.signal ?? undefined))) as unknown as typeof fetch;
  render(<Harness />); fireEvent.click(document.querySelector("button")!);
  await waitFor(() => expect(document.querySelector("output")?.textContent).toContain("assistant:Hello from Stack."));
  expect(document.querySelector("output")?.textContent).toMatch(/local:qwen3-1.7b:\d+:\d+(\.\d+)?/);
});

test("stop aborts an in-flight response", async () => {
  let requestSignal: AbortSignal | undefined;
  globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => { requestSignal = init?.signal ?? undefined; return new Promise<Response>(() => {}); }) as unknown as typeof fetch;
  render(<Harness />); fireEvent.click(document.querySelector("button")!); await waitFor(() => expect(document.querySelector("span")?.textContent).toBe("sending")); fireEvent.click(document.querySelectorAll("button")[1]!); expect(requestSignal?.aborted).toBe(true); expect(document.querySelector("span")?.textContent).toBe("idle");
});
