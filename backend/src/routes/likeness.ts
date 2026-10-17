// LIKENESS-01: the Stack's side of the household likeness rule (docs/integrations.md, "Likeness proofs"). Home alone
// decides who agreed; this route only lets Home register the public key its proofs are signed with, and tells Home
// whether a key is set. Nothing here lists a person, a picture or a proof.
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { likenessTrusted, LikenessError, MAX_PROOF_SECONDS, registerTrust, trustFingerprint } from "@/lib/likeness";

const ErrorBody = z.object({ error: z.string(), code: z.string() });
const statusRoute = createRoute({ method: "get", path: "/", tags: ["Likeness"], summary: "Whether this Stack takes likeness proofs, and from which Home key", responses: {
  200: { content: { "application/json": { schema: z.object({ likeness: z.object({ trusted: z.boolean(), fingerprint: z.string().nullable(), max_proof_minutes: z.number().int() }) }) } }, description: "`trusted` is false until Home registers its key." },
} });
const trustRoute = createRoute({ method: "put", path: "/trust", tags: ["Likeness"], summary: "Register Home's proof-signing key", request: { body: { content: { "application/json": { schema: z.object({
  public_key: z.string().min(40).max(400).openapi({ description: "Home's Ed25519 public key, base64 of the SPKI DER form." }),
  rotation_signature: z.string().max(400).optional().openapi({ description: "Needed only to replace a key already registered: the current key's signature (base64) over the new key's base64 text." }),
}) } } } }, responses: {
  200: { content: { "application/json": { schema: z.object({ result: z.enum(["registered", "unchanged", "rotated"]), fingerprint: z.string() }) } }, description: "The first key a Stack sees is trusted (it listens on loopback and Home is its only caller)." },
  409: { content: { "application/json": { schema: ErrorBody } }, description: "likeness_key_mismatch: a different key is already trusted and the request was not signed by it." },
  422: { content: { "application/json": { schema: ErrorBody } }, description: "bad_key: not an Ed25519 public key." },
} });

export const likenessRoutes = apiRouter<AppEnv>();

likenessRoutes.openapi(statusRoute, (c) => c.json({ likeness: { trusted: likenessTrusted(), fingerprint: trustFingerprint(), max_proof_minutes: MAX_PROOF_SECONDS / 60 } }, 200));

likenessRoutes.openapi(trustRoute, (c) => {
  const body = c.req.valid("json");
  try {
    const result = registerTrust(body.public_key, body.rotation_signature);
    return c.json({ result, fingerprint: trustFingerprint() ?? "" }, 200);
  } catch (error) {
    if (error instanceof LikenessError) return c.json({ error: error.message, code: error.code }, error.status as 409 | 422);
    throw error;
  }
});
