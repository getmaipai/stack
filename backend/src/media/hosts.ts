// MEDIA-STACK-01: the per-host limiter and quiet mode (THIRD-PARTY-SERVICES.md:
// behave as the person would). FileTube's circuit breaker, ported: four
// failures that mean "this host is pushing back" (a 429, a login wall) put the
// host in quiet mode for 30 minutes. In quiet mode background polls are
// refused before they reach the queue; a request a person made keeps going,
// and a success clears the host. Background requests to one host are also
// spaced so a subscription never bursts. The state is saved so a restart
// does not forget a host that asked us to stop.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mediaDir } from "./paths";

export const QUIET_AFTER_FAILURES = 4;
export const QUIET_MS = 30 * 60_000;
/** Minimum gap between the starts of two background requests to one host. A person's own request is not spaced. */
export const BACKGROUND_GAP_MS = 5_000;

const TWO_PART_SUFFIXES = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);
/** One key per site: `www.`, `m.` and other subdomains share the host's quiet mode (`music.example.co.uk` is `example.co.uk`). An IP or a single label stands as it is. */
export function hostKey(url: string): string | null {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/\.$/, ""); } catch { return null; }
  if (!host) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":") || !host.includes(".")) return host;
  const labels = host.split(".");
  const take = labels.length >= 3 && labels[labels.length - 1]!.length === 2 && TWO_PART_SUFFIXES.has(labels[labels.length - 2]!) ? 3 : 2;
  return labels.slice(-take).join(".");
}

export type FetchFailureCode = "rate_limited" | "login_wall" | "unavailable" | "unsupported" | "network" | "cancelled" | "tool_missing" | "failed";
export interface FetchFailure { code: FetchFailureCode; message: string; /** Counts toward the host's quiet mode. */ pushback: boolean; }

/** Reads yt-dlp's stderr and says what kind of failure it was (FileTube's failures.js idea). Only a host pushing back counts toward quiet mode; a removed video or an unsupported link does not. */
export function classifyFetchFailure(stderr: string): FetchFailure {
  const text = stderr.toLowerCase();
  if (/http error 429|too many requests|rate[- ]limit/.test(text)) return { code: "rate_limited", pushback: true, message: "The site says too many requests were made. The Stack will rest from this site for a while." };
  if (/sign in to confirm|confirm you.{0,8}not a bot|login required|log in to|please sign in|requires? (a )?login|use --cookies|cookies? (are|is) required|this video is only available for registered users/.test(text)) return { code: "login_wall", pushback: true, message: "The site wants a sign in before it will serve this. Add the owner's cookies in Home's media settings, or try again later." };
  if (/unsupported url|no suitable extractor/.test(text)) return { code: "unsupported", pushback: false, message: "The Stack does not know how to fetch from that link. Check that it is the page of one video or a channel." };
  if (/video unavailable|has been removed|is private|not available|http error 404|http error 410|does not exist|no video formats/.test(text)) return { code: "unavailable", pushback: false, message: "That video is not available any more (removed, private or not in this region)." };
  if (/unable to download|timed out|connection (refused|reset)|name or service not known|nodename nor servname|network is unreachable|temporary failure in name resolution|urlopen error/.test(text)) return { code: "network", pushback: false, message: "The site could not be reached. Check this computer's internet connection and try again." };
  return { code: "failed", pushback: false, message: "The fetch failed. Open Details for what the tool said." };
}

interface HostState { failures: number; quietUntil: number; lastStart: number; }

export class HostLimiter {
  private hosts = new Map<string, HostState>();
  constructor(private readonly options: { now?: () => number; file?: () => string | null } = {}) {}
  private now(): number { return (this.options.now ?? Date.now)(); }
  private state(host: string): HostState { let state = this.hosts.get(host); if (!state) { state = { failures: 0, quietUntil: 0, lastStart: 0 }; this.hosts.set(host, state); } return state; }

  /** Epoch ms when the host's quiet mode ends, or null when it is not resting. */
  quietUntil(host: string): number | null {
    const state = this.hosts.get(host);
    if (!state || state.quietUntil <= this.now()) return null;
    return state.quietUntil;
  }

  /** Whether a request may start now, and how long a background one should wait to keep its spacing. */
  admission(host: string, personInitiated: boolean): { ok: true; waitMs: number } | { ok: false; quietUntil: number } {
    const until = this.quietUntil(host);
    if (until !== null && !personInitiated) return { ok: false, quietUntil: until };
    if (personInitiated) return { ok: true, waitMs: 0 };
    const state = this.hosts.get(host);
    return { ok: true, waitMs: state ? Math.max(0, state.lastStart + BACKGROUND_GAP_MS - this.now()) : 0 };
  }

  started(host: string): void { this.state(host).lastStart = this.now(); }

  /** A request ended. A success clears the count and quiet mode; a pushback adds to the count and the fourth in a row starts quiet mode; anything else leaves the count alone. */
  record(host: string, outcome: "success" | "pushback" | "other"): { quiet: boolean; quietUntil: number | null } {
    const state = this.state(host);
    if (outcome === "success") { state.failures = 0; state.quietUntil = 0; }
    else if (outcome === "pushback") {
      state.failures += 1;
      if (state.failures >= QUIET_AFTER_FAILURES && state.quietUntil <= this.now()) state.quietUntil = this.now() + QUIET_MS;
    }
    this.save();
    const until = this.quietUntil(host);
    return { quiet: until !== null, quietUntil: until };
  }

  /** Hosts resting now, for the status route and the privacy page's "what is the Stack doing". */
  quietHosts(): Array<{ host: string; until: string; failures: number }> {
    return [...this.hosts.entries()].filter(([, state]) => state.quietUntil > this.now()).map(([host, state]) => ({ host, until: new Date(state.quietUntil).toISOString(), failures: state.failures }));
  }

  private save(): void {
    const file = this.options.file?.() ?? null;
    if (!file) return;
    try {
      mkdirSync(mediaDir(), { recursive: true, mode: 0o700 });
      const data = Object.fromEntries([...this.hosts.entries()].filter(([, s]) => s.failures > 0 || s.quietUntil > 0).map(([host, s]) => [host, { failures: s.failures, quietUntil: s.quietUntil }]));
      writeFileSync(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch { /* a missing disk must not fail a fetch */ }
  }

  load(): void {
    const file = this.options.file?.() ?? null;
    if (!file || !existsSync(file)) return;
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, { failures?: number; quietUntil?: number }>;
      for (const [host, saved] of Object.entries(data)) this.hosts.set(host, { failures: Number(saved.failures) || 0, quietUntil: Number(saved.quietUntil) || 0, lastStart: 0 });
    } catch { /* unreadable: start clean */ }
  }

  reset(): void { this.hosts.clear(); }
}

export const hostLimiter = new HostLimiter({ file: () => join(mediaDir(), "quiet-hosts.json") });
