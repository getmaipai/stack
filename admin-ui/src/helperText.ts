// Pure wording for the Helper screen: no React, no network, so tests/adminHelper.test.ts can pin it.

/** Plain words for the Helper's state, shown beside its name. */
export function helperStateWord(state: string, waking: boolean): string {
  if (waking) return "Waking up";
  if (state === "notInstalled") return "Not installed";
  if (state === "ready" || state === "loaded" || state === "busy") return "Awake";
  if (state === "offline") return "Could not start";
  return "Asleep";
}

/** Slash commands become plain questions; `/new` clears the chat. Returns null when the text is not a command. */
export function expandCommand(text: string): { send: string } | { clear: true } | null {
  const t = text.trim().toLowerCase();
  if (t === "/new") return { clear: true };
  if (t === "/health") return { send: "Is everything healthy?" };
  if (t === "/restart") return { send: "Restart the Stack." };
  if (t === "/memory") return { send: "How much memory is free right now?" };
  return null;
}
