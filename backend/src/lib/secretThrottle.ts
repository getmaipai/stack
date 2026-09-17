import { getConnInfo } from "hono/bun";
import type { Context } from "hono";

const TRUST_PROXY = process.env.STACK_TRUST_PROXY === "true";

const WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 20;
const MAX_BUCKETS = 5_000;

interface Bucket {
  fails: number;
  first: number;
  lockedUntil: number;
}
const buckets = new Map<string, Bucket>();

export function getClientIp(c: Context): string {
  if (TRUST_PROXY) {
    const forwarded = c.req.header("x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0]!.trim();
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function throttleCheck(ip: string): {
  blocked: boolean;
  retryAfter: number;
} {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b) return { blocked: false, retryAfter: 0 };
  if (b.lockedUntil > now)
    return { blocked: true, retryAfter: Math.ceil((b.lockedUntil - now) / 1000) };
  if (now - b.first > WINDOW_MS) buckets.delete(ip);
  return { blocked: false, retryAfter: 0 };
}

export function throttleFail(ip: string): void {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.first > WINDOW_MS) {
    b = { fails: 0, first: now, lockedUntil: 0 };
    if (buckets.size >= MAX_BUCKETS) {
      for (const [k, v] of buckets)
        if (v.lockedUntil <= now && now - v.first > WINDOW_MS) buckets.delete(k);
    }
    buckets.set(ip, b);
  }
  b.fails++;
  if (b.fails >= MAX_FAILS) b.lockedUntil = now + WINDOW_MS;
}

export function throttleReset(ip: string): void {
  buckets.delete(ip);
}

export function __resetThrottleForTests(): void {
  buckets.clear();
}
