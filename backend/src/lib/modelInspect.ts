// Reads a Hugging Face model file's facts without downloading its weights
// (MODEL-ADD-01 S2): the published size and sha256, the licence, the
// architecture from the file's header, and the repository's own sampling
// card. Anything unreadable comes back null with a reason, never a guess.
import { hfUrl, huggingFaceFetch, resolveHuggingFace } from "@/lib/hf";
import { runGgufParser, VERIFIED_ARCHITECTURES } from "@/lib/fitPlan";

export interface InspectedSampling { temperature?: number; top_p?: number; top_k?: number; min_p?: number; presence_penalty?: number }
export interface InspectResult {
  repo: string; revision: string; file: string; url: string;
  sizeBytes: number | null; sha256: string | null; licence: string | null; gated: boolean;
  architecture: { name: string; experts: number; verified: boolean; ramBytes: number; vramBytes: number } | null; architectureReason: string | null;
  sampling: InspectedSampling | null; samplingReason: string | null;
}
export class InspectRefusal extends Error {}

/** A pasted link or "owner/repo" plus a file. Only huggingface.co links are read. */
export function parseSource(source: string, file?: string): { repo: string; revision?: string; file?: string } {
  const text = source.trim();
  if (/^https?:\/\//i.test(text)) {
    let url: URL;
    try { url = new URL(text); } catch { throw new InspectRefusal("That link is not a web address. Paste the model's page link from huggingface.co."); }
    if (url.protocol !== "https:" || url.hostname !== "huggingface.co") throw new InspectRefusal("Only links from huggingface.co can be added. Paste the model's page link from huggingface.co.");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length < 2) throw new InspectRefusal("That link does not name a model. Paste the model's page link from huggingface.co.");
    const [owner, name, kind, revision, ...path] = parts;
    const found = (kind === "blob" || kind === "resolve") && revision && path.length ? path.join("/") : undefined;
    return { repo: `${owner}/${name}`, ...(found && revision ? { revision } : {}), file: file ?? found };
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(text)) throw new InspectRefusal("That is not a model name. Paste the model's page link from huggingface.co.");
  return { repo: text, file };
}

function num(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }

async function readSampling(repo: string, revision: string): Promise<{ sampling: InspectedSampling | null; reason: string | null }> {
  try {
    const response = await huggingFaceFetch()(hfUrl(`${repo}/resolve/${revision}/generation_config.json`));
    if (response.status === 404) return { sampling: null, reason: "The repository publishes no generation_config.json." };
    if (!response.ok) return { sampling: null, reason: `The repository's sampling card could not be read (HTTP ${response.status}).` };
    const raw = await response.json() as Record<string, unknown>;
    const sampling: InspectedSampling = {};
    for (const key of ["temperature", "top_p", "top_k", "min_p", "presence_penalty"] as const) { const value = num(raw[key]); if (value !== undefined) sampling[key] = value; }
    return Object.keys(sampling).length ? { sampling, reason: null } : { sampling: null, reason: "The repository's generation_config.json names no sampling values." };
  } catch { return { sampling: null, reason: "The repository's sampling card could not be read." }; }
}

export async function inspectModel(input: { source: string; file?: string }): Promise<InspectResult> {
  const parsed = parseSource(input.source, input.file);
  let resolution;
  try { resolution = await resolveHuggingFace(parsed.repo, { revision: parsed.revision }); } catch { throw new InspectRefusal(`${parsed.repo} could not be read on huggingface.co. Check the link and try again.`); }
  const ggufs = resolution.files.filter((entry) => entry.name.toLowerCase().endsWith(".gguf"));
  const file = parsed.file ? resolution.files.find((entry) => entry.name === parsed.file) : ggufs.length === 1 ? ggufs[0] : undefined;
  if (!file) throw new InspectRefusal(parsed.file ? `${parsed.file} is not in ${parsed.repo}. Check the file name.` : `${parsed.repo} has ${ggufs.length} model files. Paste the link to the one you want.`);
  if (!file.name.toLowerCase().endsWith(".gguf")) throw new InspectRefusal("Only GGUF model files can be added. Pick a .gguf file.");
  if (resolution.gated) throw new InspectRefusal(`${parsed.repo} is gated and needs a Hugging Face login, which MaiPai does not use. Pick an open model.`);
  const estimate = await runGgufParser({ target: { url: file.url }, contextTokens: 4096, kvCacheType: "q8_0", gpuLayers: "all" });
  const architecture = estimate ? { name: estimate.architecture, experts: estimate.expertCount, verified: (VERIFIED_ARCHITECTURES as readonly string[]).includes(estimate.architecture), ramBytes: estimate.ramNonumaBytes, vramBytes: estimate.vramNonumaBytes } : null;
  const card = await readSampling(parsed.repo, resolution.revision);
  return { repo: parsed.repo, revision: resolution.revision, file: file.name, url: file.url, sizeBytes: file.sizeBytes, sha256: file.sha256, licence: resolution.licence, gated: resolution.gated, architecture, architectureReason: architecture ? null : "The file's header could not be read, so its architecture and memory use are unknown.", sampling: card.sampling, samplingReason: card.reason };
}
