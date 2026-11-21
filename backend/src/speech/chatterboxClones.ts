// Voices made from a reference clip on the Chatterbox Turbo engine (VOICES-02). Home keeps the clip and the voice's own
// settings; the Stack receives, per request, the address of the clip on the household's own network, an optional
// sampling temperature and an optional pitch offset. Three things live here: the ranges both are checked against
// (the same ones as the HouseholdVoice record), what becomes of a request's voice on this engine, and the one-time fetch
// of the clip tokenizer.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { downloadUrl } from "@/lib/download";
import { STACK_TTS_CHATTERBOX_CLONER, CHATTERBOX_CLONER_REPO, CHATTERBOX_CLONER_REVISION } from "@/lib/modelCatalog";
import { installCatalogModel } from "@/lib/modelStore";
import { modelsDir } from "@/lib/paths";
import { sha256OfPath } from "@/lib/store/blobs";
import { hfSnapshotsRoot } from "@/lib/store/layout";
import { privateHost, VoiceRefusedError } from "@/speech/voices";

export const VOICE_TEMPERATURE_RANGE = { min: 0.1, max: 2.0 } as const;
export const VOICE_PITCH_RANGE = { min: -12, max: 12 } as const;

export const TEMPERATURE_MESSAGE = "The sampling temperature must be a number from 0.1 to 2.0.";
export const PITCH_MESSAGE = "The pitch offset must be a number from -12 to 12 semitones.";

/** The refusal for an out-of-range value, in words a person can act on; null when both are fine or absent. */
export function voiceSettingsRefusal(temperature: number | undefined, pitchSemitones: number | undefined): string | null {
  if (temperature !== undefined && !(Number.isFinite(temperature) && temperature >= VOICE_TEMPERATURE_RANGE.min && temperature <= VOICE_TEMPERATURE_RANGE.max)) return TEMPERATURE_MESSAGE;
  if (pitchSemitones !== undefined && !(Number.isFinite(pitchSemitones) && pitchSemitones >= VOICE_PITCH_RANGE.min && pitchSemitones <= VOICE_PITCH_RANGE.max)) return PITCH_MESSAGE;
  return null;
}

/** An http(s) address is a clip the household serves (the caller has already checked the host is private); a preset name or
 * anything else is a voice this engine does not have, so it speaks its default (VOICE-STUDIO-01). */
export function clipVoiceAddress(voiceUrl: string | undefined): string | undefined {
  return voiceUrl && /^https?:\/\//.test(voiceUrl) ? voiceUrl : undefined;
}

/** The file state (path, size, modified time) whose digest last matched. Hashing the 495 MB clip tokenizer on every
 * spoken sentence added about 150 ms before the first audio of each cloned-voice request (measured 2026-11-21). */
let clonerVerified: string | null = null;
export function __resetClonerCheckForTests(): void { clonerVerified = null; }

/** Whether the file at `path` has the expected digest. The digest is computed once per file state: a file that is
 * replaced, resized or rewritten is hashed again, and a mismatch is never remembered. */
export async function fileVerifiedOnce(path: string, expected: string, digestOf: (path: string) => Promise<string> = sha256OfPath): Promise<boolean> {
  if (!existsSync(path)) return false;
  const stat = statSync(path);
  const state = `${path}:${stat.size}:${stat.mtimeMs}`;
  if (clonerVerified === state) return true;
  if ((await digestOf(path)) !== expected) return false;
  clonerVerified = state;
  return true;
}

export async function chatterboxClonerPresent(): Promise<boolean> {
  const download = STACK_TTS_CHATTERBOX_CLONER.download!;
  return fileVerifiedOnce(join(hfSnapshotsRoot(CHATTERBOX_CLONER_REPO), CHATTERBOX_CLONER_REVISION, download.hub_file!), download.sha256);
}

/** The suite's stand-in for the 495 MB fetch; null outside tests. */
let clonerForTests: (() => Promise<void>) | null = null;
export function __setClonerForTests(fetcher: (() => Promise<void>) | null): void { clonerForTests = fetcher; }

/** Fetches the clip tokenizer once (verified against the pinned digest), so the engine can encode a clip offline. */
export async function ensureChatterboxCloner(options: { signal?: AbortSignal; download?: typeof downloadUrl } = {}): Promise<void> {
  if (clonerForTests) return clonerForTests();
  if (await chatterboxClonerPresent()) return;
  await installCatalogModel(STACK_TTS_CHATTERBOX_CLONER, { destination: join(modelsDir, STACK_TTS_CHATTERBOX_CLONER.id, "model.safetensors"), download: options.download ?? downloadUrl, signal: options.signal });
}

/** What a request's voice becomes on the Chatterbox engine: nothing (its default voice) for a preset name or no voice; for a
 * clip address, the same address once its host is on the household's own network and the clip tokenizer is on disk. */
export async function prepareChatterboxVoice(voiceUrl: string | undefined, options: { signal?: AbortSignal; download?: typeof downloadUrl } = {}): Promise<string | undefined> {
  const address = clipVoiceAddress(voiceUrl);
  if (!address) return undefined;
  let host: string;
  try { host = new URL(address).hostname; } catch { throw new VoiceRefusedError("The voice address is not a web address.", 400, "voice-not-pinnable"); }
  if (!privateHost(host)) throw new VoiceRefusedError(`The voice at ${host} is not on this household's own network, so the Stack will not fetch it. Make the voice in Home instead.`, 400, "voice-not-pinnable");
  try {
    await ensureChatterboxCloner(options);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new VoiceRefusedError("Voice cloning needs a 495 MB helper file that the Stack could not download. Check that this computer is online, then try the voice again.", 409, "voice-cloning-unavailable");
  }
  return address;
}
