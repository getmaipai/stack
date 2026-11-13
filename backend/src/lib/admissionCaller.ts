import { isHomeCaller, HOME_TOKEN_HEADER } from "@/lib/adultView";
import type { Context } from "hono";
import type { AppEnv } from "@/types";

/** Caller priority is trusted only when Home's paired token is present. */
export function admissionCaller(c: Context<AppEnv>) {
  const requested = c.req.header("x-stack-caller");
  if (requested === "live" && isHomeCaller((name) => name === HOME_TOKEN_HEADER ? c.req.header(name) : undefined)) return "household" as const;
  return requested === "test" ? "test" as const : "dev" as const;
}
