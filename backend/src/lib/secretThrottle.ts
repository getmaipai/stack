import { getConnInfo } from "hono/bun";
import type { Context } from "hono";

const TRUST_PROXY = process.env.STACK_TRUST_PROXY === "true";

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
