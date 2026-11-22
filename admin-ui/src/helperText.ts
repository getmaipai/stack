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

/** "on" and "off" read as On and Off; numbers, build names and everything else stay as written. */
export function valueWord(v: string): string { return v === "on" || v === "off" ? v[0]!.toUpperCase() + v.slice(1) : v; }
/** One line of a confirm card: what changes, from what, to what. */
export function changeLine(c: { label: string; from: string; to: string }): string { return `${c.label}: ${valueWord(c.from)} to ${valueWord(c.to)}`; }
/** How long a card keeps waiting, in plain words. */
export function waitsText(expiresAt: string, now = Date.now()): string {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "This request has run out. Ask again.";
  const minutes = Math.ceil(ms / 60_000);
  return `Waits ${minutes} more minute${minutes === 1 ? "" : "s"}.`;
}
/** The key combination that opens the Helper from any screen. */
export const HELPER_SHORTCUT = { key: "/", mac: "⌘/", other: "Ctrl+/" } as const;
export function isHelperShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return e.key === HELPER_SHORTCUT.key && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
}
