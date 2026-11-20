import type { StackMakeRequest, StackMakeRefusal } from "@maipai/spec/stack/ts/stack-make.js";
import type { StackOperationRow, StackCapabilityOperation } from "@maipai/spec/stack/ts/stack-model-pack.js";
import { checkVideoInputs } from "@/video/caps";

type ClipRequest = Extract<StackMakeRequest, { job: "clip" }>;
export type PlannedClipRoute =
  | { ok: true; route: "words" | "start_picture" | "start_end_pictures" | "references"; operation: StackCapabilityOperation | "retake" | "extend" | "restyle"; identityUsed: number; reason: string; /** The request is a film shot: the dispatcher chooses the Max recipe from the machine (no size field). */ filmShot?: true }
  | { ok: false; refusal: StackMakeRefusal };

export const NEEDS_START_PICTURE_LINE = "This model holds a person only from a first picture. Make one from the person's picture and send it as the start picture.";
const refuse = (line: string): PlannedClipRoute => ({ ok: false, refusal: { code: "input_not_supported", line } });

export function planClipRoute(request: ClipRequest, rows: readonly StackOperationRow[]): PlannedClipRoute {
  const identityCount = request.inputs?.filter((input) => input.role === "identity").length ?? 0;
  const hasVoice = request.inputs?.some((input) => input.role === "voice_reference") ?? false;
  const hasWardrobe = request.inputs?.some((input) => input.role === "wardrobe") ?? false;
  const hasEditSource = request.inputs?.some((input) => input.role === "edit_source") ?? false;
  if (request.operation === "enhance") return refuse("Enhancing a clip has its own request.");
  if (request.operation === "restyle") {
    if (request.start_picture || request.end_picture || identityCount || hasVoice || hasWardrobe || (request.inputs ?? []).some((input) => input.role !== "edit_source")) return refuse("Restyling a clip cannot be combined with pictures or other inputs.");
    if ((request.inputs ?? []).filter((input) => input.role === "edit_source").length !== 1) return refuse("Send one edit_source clip to restyle.");
    if (!request.styles || request.styles.length !== 1) return refuse("Choose one installed style to restyle the clip.");
    if (request.level !== "max" || !rows.some((candidate) => candidate.operation === "retake" && candidate.level === "max" && candidate.available)) return refuse("Restyling a clip is not available at the chosen quality.");
    return { ok: true, route: "words", operation: "restyle", identityUsed: 0, reason: "Restyling the clip you sent." };
  }
  if (request.operation === "retake_from" || request.operation === "extend") {
    if (request.start_picture || request.end_picture || identityCount || hasVoice || hasWardrobe || (request.inputs ?? []).some((input) => input.role !== "edit_source")) return refuse("Retaking or extending a clip cannot be combined with pictures or other inputs.");
    if (!hasEditSource) return refuse("Send an edit_source clip to retake or extend.");
    if (request.operation === "retake_from" && request.at_seconds === undefined) return refuse("Send at_seconds to choose where the retake starts.");
    if (request.operation === "extend" && request.seconds === undefined) return refuse("Send seconds to choose how much to add.");
    const operation = request.operation === "retake_from" ? "retake" : "extend";
    const selected = rows.find((candidate) => candidate.operation === operation && candidate.level === request.level);
    if (!selected) return refuse("This clip operation is not available at the chosen quality.");
    const rowRefusal = checkVideoInputs(selected, { source_clip: true, seconds: request.operation === "retake_from" ? request.at_seconds : request.seconds });
    if (rowRefusal) return { ok: false, refusal: { code: "input_not_supported", line: rowRefusal.line } };
    return { ok: true, route: "words", operation, identityUsed: 0, reason: request.operation === "retake_from" ? `Retaking from ${request.at_seconds} seconds on the clip you sent.` : `Extending the clip you sent by ${request.seconds} seconds.` };
  }
  if (request.take_of) {
    const selected = rows.find((candidate) => candidate.operation === "clip_text" && candidate.level === request.level);
    if (!selected) return refuse("This clip operation is not available at the chosen quality.");
    const rowRefusal = checkVideoInputs(selected, { seconds: request.seconds });
    if (rowRefusal) return { ok: false, refusal: { code: "input_not_supported", line: rowRefusal.line } };
    return { ok: true, route: "words", operation: "clip_text", identityUsed: 0, reason: "The clip is made from words." };
  }
  if (hasEditSource) return refuse("Use the retake, extend or enhance operations for an existing clip.");

  let route: "words" | "start_picture" | "start_end_pictures" | "references";
  let operation: StackCapabilityOperation;
  let identityUsed = 0;
  let reason: string;
  if (request.intent === "derived_start" && !request.start_picture) return refuse("A clip marked as made from a derived first picture must carry that picture as its start picture.");
  if (request.start_picture && request.end_picture) {
    route = "start_end_pictures"; operation = "clip_start_end_pictures";
    reason = identityCount ? "The start picture opens the shot; identity pictures are recorded in the receipt, not used to hold the person in this clip." : "The clip opens and closes on the pictures you sent.";
  } else if (request.start_picture) {
    route = "start_picture"; operation = "clip_start_picture";
    reason = request.intent === "derived_start" ? "The start picture was made from the identity picture and opens the shot." : identityCount ? "The start picture opens the shot; identity pictures are recorded in the receipt, not used to hold the person in this clip." : "The start picture opens the shot.";
  } else if (identityCount > 0) {
    const row = rows.find((candidate) => candidate.operation === "clip_references" && candidate.level === request.level && candidate.available);
    if (!row) return { ok: false, refusal: { code: "needs_start_picture", line: NEEDS_START_PICTURE_LINE, shape: request.shape, inputs: hasWardrobe ? ["identity", "wardrobe"] : ["identity"] } };
    route = "references"; operation = "clip_references";
    identityUsed = Math.min(identityCount, row.inputs.references, 1);   // ONE identity picture by default; more only when admission for more is built (a row alone does not say the machine admits it)
    const setAside = identityCount - identityUsed;
    reason = `${identityUsed} identity ${identityUsed === 1 ? "picture" : "pictures"} used${setAside ? `; ${setAside} identity ${setAside === 1 ? "picture" : "pictures"} set aside` : ""}.`;
  } else {
    route = "words"; operation = "clip_text"; reason = "The clip is made from words.";
  }

  const selected = rows.find((candidate) => candidate.operation === operation && candidate.level === request.level);
  if (!selected) return refuse("This clip operation is not available at the chosen quality.");
  const rowRefusal = checkVideoInputs(selected, { start_picture: !!request.start_picture, end_picture: !!request.end_picture, references: route === "references" ? identityUsed : 0, seconds: request.seconds });
  if (rowRefusal) return { ok: false, refusal: { code: "input_not_supported", line: rowRefusal.line } };
  if (hasWardrobe && route !== "references") return refuse("Wardrobe pictures are only supported with reference-picture clips.");
  if (hasVoice && !selected.sound.voice_reference) return refuse("This clip operation does not support a voice reference.");
  return { ok: true, route, operation, identityUsed, reason, ...(request.operation === "clip_film_shot" ? { filmShot: true as const } : {}) };
}
