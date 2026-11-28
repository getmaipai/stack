/** Words for app keys on the Connections screen. One place, so the page and its test say the same thing. */
export type AppKeyScope = "chat" | "vision" | "speech" | "models";
export const SCOPE_CHOICES: { id: AppKeyScope; label: string; help: string }[] = [
  { id: "chat", label: "Chat", help: "Text answers and coding." },
  { id: "vision", label: "Vision", help: "Questions about pictures." },
  { id: "speech", label: "Speech", help: "Speech to text and text to speech." },
  { id: "models", label: "Models list", help: "Lets the program see what is available." },
];
export const DEFAULT_SCOPES: AppKeyScope[] = ["chat", "models"];
export const scopeLabel = (id: string): string => SCOPE_CHOICES.find((s) => s.id === id)?.label ?? id;
/** "Never used" or "Last used 3 minutes ago, 12 requests". */
export function useWords(lastUsedAt: string | null, count: number, agoWord: (iso: string) => string): string {
  if (!lastUsedAt) return "Never used.";
  return `Last used ${agoWord(lastUsedAt)}, ${count} ${count === 1 ? "request" : "requests"} in all.`;
}
/** The address a program puts in its "base URL" box: this page's own address plus /v1. */
export const baseUrl = (origin: string): string => `${origin.replace(/\/+$/, "")}/v1`;
