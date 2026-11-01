// TIER-ROUTES-01: the optional `tier` every generation route accepts, and how it reaches the governor (TIER-STACK-02 reads `input.tier`).
import { z } from "@hono/zod-openapi";
import type { Job } from "@/lib/jobs";

export const TierFieldSchema = z.enum(["standard", "boost", "max"]).optional().openapi({ description: "Which level the job runs at: `standard` (the default), `boost` or `max`. Boost and Max may use more of the computer's memory than Standard; a Max job opens the Max window (other jobs wait, chat may run on its smaller model until the job ends). A job too big for its level is refused with the reason. Home decides who may ask for Boost or Max; the Stack takes the word as given. The status and GET /stack/v1/jobs/{id} report it." });
export const TierStatusSchema = z.enum(["standard", "boost", "max"]).openapi({ description: "The level the job was submitted at (`standard` when none was named)." });

/** The job input fragment: present only when the caller named a tier, so an unnamed job keeps the governor's untiered admission. */
export const tierInput = (tier: "standard" | "boost" | "max" | undefined): { tier?: "standard" | "boost" | "max" } => tier ? { tier } : {};
/** The tier a job reports. */
export const tierOf = (job: Job): "standard" | "boost" | "max" => { const tier = (job.input as { tier?: string } | null)?.tier; return tier === "boost" || tier === "max" ? tier : "standard"; };
