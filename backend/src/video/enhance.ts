// VF-ENHANCE-01 (Stack half, the door only): the `enhance` video operation, a Refine Details pass over a finished clip.
// Rule 11: only our own tested, pinned Stack parts run a model. No enhance adapter is pinned yet (the film session's Refine Details
// test has not passed), so the door refuses with `not_installed` and runs nothing. When the adapter becomes a pinned part, set
// ENHANCE_ADAPTER_PART to its id and make `enhanceAdapterInstalled` read the part's install state; nothing else here changes.
//
// The refusal has the shape of `StackMakeRefusal`'s `not_installed` code (commons spec-v0.1.431). This Stack still pins an older
// spec, so the shape is declared here and moves to the spec import when the pin is bumped.
import { z } from "zod";

/** The pinned part that would serve `enhance`. Null until the adapter is pinned and tested. */
export const ENHANCE_ADAPTER_PART: string | null = null;
export const EnhanceRefusal = z.object({ code: z.literal("not_installed"), line: z.string().min(1).max(300) }).strict();
export type EnhanceRefusal = z.infer<typeof EnhanceRefusal>;
export const ENHANCE_NOT_INSTALLED_LINE = "Refine Details is not installed on this computer yet. Your clip is unchanged; use the original, or try again after an update adds it.";

let installedOverride: (() => boolean) | null = null;
export function setEnhanceInstalledForTests(check: (() => boolean) | null): void { installedOverride = check; }
/** True only when the adapter is a pinned part that is installed and verified. */
export function enhanceAdapterInstalled(): boolean {
  if (installedOverride) return installedOverride();
  return ENHANCE_ADAPTER_PART !== null && false;
}
export const enhanceRefusal = (): EnhanceRefusal => ({ code: "not_installed", line: ENHANCE_NOT_INSTALLED_LINE });
