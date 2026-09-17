import { useCallback, useRef, useState } from "react";

export interface StackChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  metrics?: StackChatMetrics;
  error?: string;
}

export interface StackChatMetrics {
  engine: string;
  model: string;
  firstTokenMs: number | null;
  tokensPerSecond: number | null;
}

export type StackChatStatus = "idle" | "sending" | "streaming" | "error";

function countTokens(text: string): number { return text.trim() ? text.trim().split(/\s+/u).length : 0; }

export function useStackChat() {
  const [messages, setMessages] = useState<StackChatMessage[]>([]);
  const [status, setStatus] = useState<StackChatStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  const stop = useCallback(() => { controller.current?.abort(); controller.current = null; setStatus("idle"); }, []);

  const send = useCallback(async (content: string) => {
    const prompt = content.trim(); if (!prompt || controller.current) return;
    const user: StackChatMessage = { id: crypto.randomUUID(), role: "user", content: prompt };
    const assistantId = crypto.randomUUID(); const assistant: StackChatMessage = { id: assistantId, role: "assistant", content: "" };
    setMessages((current) => [...current, user, assistant]); setError(null); setStatus("sending");
    const abort = new AbortController(); controller.current = abort; const started = performance.now(); let firstTokenMs: number | null = null; let output = ""; let tokens = 0; let metrics: StackChatMetrics = { engine: "none", model: "chat", firstTokenMs: null, tokensPerSecond: null };
    try {
      const response = await fetch("/v1/chat/completions", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "chat", stream: true, messages: [...messages, user].map(({ role, content: text }) => ({ role, content: text })) }), signal: abort.signal });
      metrics = { ...metrics, engine: response.headers.get("x-maipai-engine") ?? "none", model: response.headers.get("x-maipai-model") ?? "chat" };
      if (!response.ok || !response.body) { const body = await response.json().catch(() => ({})) as { error?: string; offline_reason?: string }; throw new Error(body.offline_reason ?? body.error ?? `The Stack returned HTTP ${response.status}.`); }
      setStatus("streaming"); const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = "";
      const consume = (chunk: string) => { pending += chunk.replaceAll("\r\n", "\n"); const events = pending.split("\n\n"); pending = events.pop() ?? ""; for (const event of events) { const line = event.split("\n").find((value) => value.startsWith("data:")); const data = line?.slice(5).trim(); if (!data || data === "[DONE]") continue; const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }; const delta = parsed.choices?.[0]?.delta?.content ?? ""; if (!delta) continue; if (firstTokenMs === null) firstTokenMs = performance.now() - started; output += delta; tokens += countTokens(delta); const elapsed = Math.max(1, performance.now() - (started + (firstTokenMs ?? 0))); const nextMetrics = { ...metrics, firstTokenMs: Math.round(firstTokenMs), tokensPerSecond: Math.round(tokens / (elapsed / 1000) * 10) / 10 }; metrics = nextMetrics; setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, content: output, metrics: nextMetrics } : message)); } };
      while (true) { const next = await reader.read(); if (next.done) { consume(decoder.decode()); break; } consume(decoder.decode(next.value, { stream: true })); }
      setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, metrics: { ...metrics, firstTokenMs: firstTokenMs === null ? null : Math.round(firstTokenMs), tokensPerSecond: firstTokenMs === null ? null : metrics.tokensPerSecond } } : message)); setStatus("idle");
    } catch (caught) { if (abort.signal.aborted) { setStatus("idle"); } else { const message = caught instanceof Error ? caught.message : "The Stack could not complete that message."; setError(message); setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, error: message } : item)); setStatus("error"); } }
    finally { controller.current = null; }
  }, [messages]);

  return { messages, status, error, send, stop };
}
