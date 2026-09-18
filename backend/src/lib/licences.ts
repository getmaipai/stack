export type LicenceFlag = "personal" | "commercial" | "gated" | "nonCommercial" | "unknown";
export interface LicenceInfo { sentence: string; flag: LicenceFlag; url: string | null; }

const unknown: LicenceInfo = { sentence: "Read it before you rely on it.", flag: "unknown", url: null };
export const LICENCES: Record<string, LicenceInfo> = {
  "Apache-2.0": { sentence: "Free to use, including in a business, if you keep the notice.", flag: "commercial", url: "https://www.apache.org/licenses/LICENSE-2.0" },
  MIT: { sentence: "Free to use, including in a business, if you keep the notice.", flag: "commercial", url: "https://opensource.org/license/mit" },
  "BSD-2-Clause": { sentence: "Free to use, including in a business, if you keep the notice.", flag: "commercial", url: "https://opensource.org/license/bsd-2-clause" },
  "Llama community": { sentence: "Free for many uses, but check Meta's community terms before using it in a business.", flag: "gated", url: "https://www.llama.com/llama-downloads/" },
  "Llama community 3.1": { sentence: "Free for many uses, but check Meta's community terms before using it in a business.", flag: "gated", url: "https://www.llama.com/llama-downloads/" },
  "Llama community 3.2": { sentence: "Free for many uses, but check Meta's community terms before using it in a business.", flag: "gated", url: "https://www.llama.com/llama-downloads/" },
  "Gemma terms": { sentence: "Free for many uses, but Google's terms may limit some commercial uses.", flag: "gated", url: "https://ai.google.dev/gemma/terms" },
  "Qwen research": { sentence: "For research and non-commercial use only.", flag: "nonCommercial", url: "https://huggingface.co/Qwen" },
  "Qwen Apache": { sentence: "Free to use, including in a business, if you keep the notice.", flag: "commercial", url: "https://www.apache.org/licenses/LICENSE-2.0" },
  "Qwen Apache-2.0": { sentence: "Free to use, including in a business, if you keep the notice.", flag: "commercial", url: "https://www.apache.org/licenses/LICENSE-2.0" },
  "CC-BY-NC": { sentence: "Free to share and adapt with credit, but not for a business.", flag: "nonCommercial", url: "https://creativecommons.org/licenses/by-nc/4.0/" },
  "CC-BY": { sentence: "Free to share and adapt with credit, including in a business.", flag: "commercial", url: "https://creativecommons.org/licenses/by/4.0/" },
  OpenRAIL: { sentence: "Free to use, but the use restrictions in the responsible-AI terms still apply.", flag: "gated", url: "https://www.licenses.ai/" },
};

export function licenceInfo(id: string | null | undefined): LicenceInfo {
  return id ? LICENCES[id] ?? unknown : unknown;
}
