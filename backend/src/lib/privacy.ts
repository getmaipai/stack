// The Stack's outbound endpoints, as data for Home's privacy page (the
// org "what leaves the house" table). Every fetch target in this backend
// has a row here; tests/privacyRows.test.ts fails when one does not.
import { z } from "zod";

export const PrivacyRowSchema = z.object({
  id: z.string(),
  what: z.string(),
  when: z.string(),
  carries: z.string(),
  receiver: z.string(),
  setting: z.string().nullable(),
  hosts: z.array(z.string()),
});
export type PrivacyRow = z.infer<typeof PrivacyRowSchema>;

export const PRIVACY_ROWS: PrivacyRow[] = [
  {
    id: "catalog-index",
    what: "Checking for engine and model updates",
    when: "Only when Home has switched update checks on, then when Home's schedule calls the check",
    carries: "A GET with If-None-Match and User-Agent: maipai-stack/<version> (<os>-<arch>), no query string or identifier",
    receiver: "The Catalog's signed index on GitHub",
    setting: "stack.updates.enabled",
    hosts: ["github.com"],
  },
  {
    id: "downloads",
    what: "Downloading a model or an engine build",
    when: "Only when Home installs one or applies an update",
    carries: "The name of the pinned file",
    receiver: "Hugging Face or the mirror declared in stack.updates.model_host for models, and GitHub for engine archives, straight from this computer",
    setting: null,
    hosts: ["huggingface.co", "github.com"],
  },
  {
    id: "provenance",
    what: "Reading a model's provenance before install",
    when: "Only when Home asks to install a model by repository",
    carries: "The repository name, then its immutable revision and file list",
    receiver: "Hugging Face or the declared mirror",
    setting: null,
    hosts: ["huggingface.co"],
  },
  {
    id: "tts-environment",
    what: "Building the voice engine's environment (the Python packages Pocket TTS runs on)",
    when: "Only when Home installs the voice engine, and again when the Stack updates it",
    carries: "The names of the pinned packages and their hashes; uv, the tool that fetches them, comes from GitHub and sends nothing else",
    receiver: "The Python Package Index, straight from this computer, and GitHub for the uv build",
    setting: null,
    hosts: ["pypi.org", "files.pythonhosted.org", "github.com", "docs.astral.sh"],
  },
  {
    id: "tts-voices",
    what: "The voice engine asking Hugging Face for its weights and voices",
    when: "Each time the voice engine starts (it asks for the voice-cloning weights, and reads the pinned copy on this computer when the ask is refused without a token), and when a person picks a voice the computer does not hold yet",
    carries: "The file's name, and the Hugging Face token from settings when one is set, so the cloning weights can be read",
    receiver: "Hugging Face, straight from this computer",
    setting: "stack.engines.tts.hf_token",
    hosts: ["huggingface.co"],
  },
];
