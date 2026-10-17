// LIKENESS-01 (Stack half): proof that Home allowed a picture, video or style to look like a real household adult.
//
// The ruling (owner, 2026-10-17): an adult may make a picture, a video or a saved style that looks like a household
// adult who agreed. The consent lives in Home (the person's own setting); the Stack never decides who agreed. What the
// Stack does is refuse to act on a likeness without a short-lived proof that Home signed for that one thing, so a
// request that skips Home, or a proof that was forged, copied for another picture or kept past its minutes, does nothing.
//
// Shape. A proof is `<payload>.<signature>`, both base64url. The payload is JSON: `v` 1, `purpose` (photo: a photo of the
// subject starts a clip or a picture edit; style_import: a saved style of the subject is added; style_use: that style
// is applied), `subject` and `requester` (opaque ids, never logged), `bind` (what the proof is for: the photo's sha256, the
// style's id, or the style's file hash), `iat`, `exp` and `jti` (seconds, an id). The signature is Ed25519 over the
// payload text with Home's key. A proof lives at most 30 minutes; Home mints one per request, and the Stack accepts each
// one once (its `jti` is remembered until it expires), so a copy of a proof cannot start a second job.
//
// Trust. Home registers its public key once (PUT /stack/v1/likeness/trust). The first key a Stack sees is trusted (the
// Stack listens on loopback and Home is its only caller); a different key replaces it only when the current key signs the
// new one, so a process that merely reaches the port cannot swap the key. Until a key is registered every proof is refused.
//
// Logs: nothing here logs a proof, an id or a picture.
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";

export type ProofPurpose = "photo" | "style_import" | "style_use";
const PURPOSES: readonly string[] = ["photo", "style_import", "style_use"];
export interface ProofPayload { v: 1; purpose: ProofPurpose; subject: string; requester: string; bind: string; iat: number; exp: number; jti: string }

export const MAX_PROOF_SECONDS = 30 * 60;
const SKEW_SECONDS = 30;

export class LikenessError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}

const trustPath = (): string => join(dataDir, "likeness", "trust.json");
let clock: () => number = () => Date.now();
/** Test seam: the clock proofs are checked against (null restores). */
export function __setLikenessClockForTests(now: (() => number) | null): void { clock = now ?? (() => Date.now()); }

function b64urlToBuffer(text: string): Buffer { return Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64"); }

function readTrusted(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(trustPath(), "utf8")) as { public_key?: unknown };
    return typeof parsed.public_key === "string" && parsed.public_key ? parsed.public_key : null;
  } catch { return null; }
}

function publicKeyOf(spkiBase64: string) {
  try { return createPublicKey({ key: Buffer.from(spkiBase64, "base64"), format: "der", type: "spki" }); } catch { return null; }
}

/** A short fingerprint of the trusted key for the status route (not secret: the key is public). */
export function trustFingerprint(): string | null {
  const key = readTrusted();
  return key ? createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 16) : null;
}

export function likenessTrusted(): boolean { return readTrusted() !== null; }

/** Registers Home's public key (base64 of the SPKI DER). The first key is trusted; a different one needs `rotationSignature`, the current key's signature (base64) over the new key's base64 text. */
export function registerTrust(publicKey: string, rotationSignature?: string): "registered" | "unchanged" | "rotated" {
  const candidate = publicKeyOf(publicKey);
  if (!candidate || candidate.asymmetricKeyType !== "ed25519") throw new LikenessError("bad_key", "The key must be an Ed25519 public key (base64 of the SPKI DER form).", 422);
  const current = readTrusted();
  if (current === publicKey) return "unchanged";
  if (current) {
    const currentKey = publicKeyOf(current);
    const ok = !!rotationSignature && !!currentKey && verifySignature(null, Buffer.from(publicKey), currentKey, Buffer.from(rotationSignature, "base64"));
    if (!ok) throw new LikenessError("likeness_key_mismatch", "This Stack already trusts a different Home key for likeness. Home must sign the new key with the old one, or an owner can reset it by deleting data/likeness/trust.json on this computer and restarting the Stack.", 409);
  }
  mkdirSync(join(dataDir, "likeness"), { recursive: true, mode: 0o700 });
  const temp = `${trustPath()}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ public_key: publicKey, set_at: new Date(clock()).toISOString() }), { mode: 0o600 });
  renameSync(temp, trustPath());
  return current ? "rotated" : "registered";
}

export interface ProofExpectation {
  purpose: ProofPurpose;
  /** What the proof must be bound to (a picture's hash, a style's id or a style file's hash). */
  bind: string;
  /** True when a job is being admitted: the proof is then used up (a second use is refused). The check made when a queued job starts leaves it alone. */
  consume?: boolean;
}

/** `jti` to expiry, for proofs already used. Memory only: a Stack restart forgets them, which the 30 minute cap bounds. */
const used = new Map<string, number>();
function forgetExpired(now: number): void { for (const [id, exp] of used) if (exp <= now) used.delete(id); }
export function __resetUsedProofsForTests(): void { used.clear(); }

/** The payload of a valid proof, or a LikenessError that says what is wrong. Checks, in order: a key is trusted, the shape, the signature, the purpose, the binding, then the clock. */
export function verifyProof(token: unknown, expected: ProofExpectation): ProofPayload {
  const trusted = readTrusted();
  if (!trusted) throw new LikenessError("likeness_not_trusted", "This Stack has not been told which Home it takes likeness proofs from. Open Home once with the engine running, then try again.", 403);
  if (typeof token !== "string" || token.length === 0) throw new LikenessError("likeness_proof_required", "A picture, video or style that looks like a person needs Home's proof that they agreed. Ask Home to make it.", 403);
  if (token.length > 4096) throw new LikenessError("likeness_proof_invalid", "The consent proof was not accepted. Ask Home to make it again.", 403);
  const parts = token.split(".");
  const invalid = new LikenessError("likeness_proof_invalid", "The consent proof was not accepted. Ask Home to make it again.", 403);
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalid;
  const key = publicKeyOf(trusted);
  if (!key) throw invalid;
  let signatureOk = false;
  try { signatureOk = verifySignature(null, Buffer.from(parts[0]), key, b64urlToBuffer(parts[1])); } catch { signatureOk = false; }
  if (!signatureOk) throw invalid;
  let payload: ProofPayload;
  try {
    const parsed: unknown = JSON.parse(b64urlToBuffer(parts[0]).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid;
    payload = parsed as ProofPayload;
  } catch { throw invalid; }
  const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  if (payload.v !== 1 || !PURPOSES.includes(payload.purpose) || typeof payload.subject !== "string" || !payload.subject || payload.subject.length > 200 || typeof payload.requester !== "string" || typeof payload.bind !== "string" || !whole(payload.iat) || !whole(payload.exp) || typeof payload.jti !== "string" || payload.jti.length < 8 || payload.jti.length > 100) throw invalid;
  if (payload.purpose !== expected.purpose) throw new LikenessError("likeness_proof_mismatch", "That consent proof is for something else. Ask Home to make it again.", 403);
  if (payload.bind !== expected.bind) throw new LikenessError("likeness_proof_mismatch", "That consent proof is for a different picture or style. Ask Home to make it again.", 403);
  const now = Math.floor(clock() / 1000);
  if (payload.exp - payload.iat > MAX_PROOF_SECONDS || payload.exp <= payload.iat) throw invalid;
  if (payload.iat > now + SKEW_SECONDS) throw invalid;
  if (now >= payload.exp) throw new LikenessError("likeness_proof_expired", "The consent proof ran out of time before the job started. Ask Home to make it again; the person's agreement is checked again then.", 403);
  if (expected.consume) {
    forgetExpired(now);
    if (used.has(payload.jti)) throw new LikenessError("likeness_proof_replayed", "That consent proof was already used. Ask Home to make it again.", 403);
    used.set(payload.jti, payload.exp);
  }
  return payload;
}

/** The sha256 a photo proof is bound to. */
export function photoBind(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

/** What a job stashes so it can check again when it actually starts (a job can wait in the line for minutes). */
export interface LikenessCheck { purpose: ProofPurpose; bind: string; token: string }
export function recheck(checks: readonly LikenessCheck[] | undefined): void {
  for (const check of checks ?? []) verifyProof(check.token, { purpose: check.purpose, bind: check.bind });
}
