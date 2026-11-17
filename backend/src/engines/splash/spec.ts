// ENGINESPEC-STACK-01: what the Stack knows about Splash itself (machine floors, the tiers it serves coding on, the reasoning effort it
// applies by default) is data in `engine.json` beside this file, as a model's limits are data in its pack. This file validates it
// when the Stack starts; `lib/splash.ts` reads it and knows no number of its own. A Splash release that moves a floor changes the
// JSON and the pin, not the code. The JSON is a static import so a compiled binary embeds it.
import { z } from "zod";
import engineJson from "./engine.json" with { type: "json" };

/** The tier names the governor knows (`GovernorRules.tiers`); kept here as data so this file imports no runtime from lib/. */
const TIER_NAMES = ["p16", "p32", "p64", "p128"] as const;
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const SplashEngineSpec = z.object({
  engine: z.literal("splash"),
  floors: z.object({
    memory_gb: z.number().int().positive(),
    chip_generation: z.number().int().min(1),
    macos: z.tuple([z.number().int().min(1), z.number().int().min(0)]),
  }).strict(),
  tiers: z.array(z.enum(TIER_NAMES)).min(1).refine((t) => new Set(t).size === t.length, "a tier is listed twice"),
  defaults: z.object({ reasoning_effort: z.enum(EFFORTS) }).strict(),
}).strict();
export type SplashEngineSpec = z.infer<typeof SplashEngineSpec>;

export function loadSplashSpec(raw: unknown = engineJson): SplashEngineSpec {
  const parsed = SplashEngineSpec.safeParse(raw);
  if (!parsed.success) throw new Error(`The Splash engine data is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. Fix engine.json in backend/src/engines/splash/.`);
  return parsed.data;
}

let cached: SplashEngineSpec | null = null;
/** The Splash data, validated once. Calling it at boot is what makes a broken file stop the Stack. */
export function splashSpec(): SplashEngineSpec { return (cached ??= loadSplashSpec()); }
