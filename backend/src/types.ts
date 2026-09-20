import type { Env } from "hono";

// The Stack's Hono environment: no per-request variables, because there
// is no caller identity to carry. Loopback is the whole authentication.
export type AppEnv = Env;
