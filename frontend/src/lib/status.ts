// The one status-to-appearance map (spec section 4's State table).
// Every component status renders through this, never a local switch.

export type StatusKind = "running" | "ready" | "stopped" | "detected" | "update" | "warning" | "error" | "loading" | "disabled" | "unavailable";

export type StatusHue = "teal" | "blue" | "violet" | "orange" | "red" | "muted";

export interface StatusEntry {
  label: string;
  hue: StatusHue;
  dot: boolean;
}

// dot is false only for "loading": spec section 4 gives it a skeleton or a
// local spinner instead of a status dot. Every other kind, muted states
// included, still carries a dot (a muted-gray dot is how "unavailable" and
// "disabled" read as inactive rather than simply missing).
export const statusMap: Record<StatusKind, StatusEntry> = {
  running: { label: "Running", hue: "teal", dot: true },
  ready: { label: "Ready", hue: "teal", dot: true },
  stopped: { label: "Stopped", hue: "muted", dot: true },
  detected: { label: "Detected", hue: "blue", dot: true },
  update: { label: "Update available", hue: "violet", dot: true },
  warning: { label: "Needs attention", hue: "orange", dot: true },
  error: { label: "Error", hue: "red", dot: true },
  loading: { label: "Loading", hue: "muted", dot: false },
  disabled: { label: "Unavailable", hue: "muted", dot: true },
  unavailable: { label: "Not reported", hue: "muted", dot: true },
};

export function statusFor(kind: StatusKind): StatusEntry {
  return statusMap[kind];
}

export function statusDotClass(kind: StatusKind): string {
  const { hue } = statusFor(kind);
  return hue === "muted" ? "bg-[var(--muted-foreground)]" : `bg-[var(--hue-${hue})]`;
}
