// Models the Stack no longer carries (owner decision, 2026-11-21: the Ornith 1.5 122B coding
// model is gone; Flash Next is the Max coding and Max chat model, Qwen3.8 27B the everyday
// coding model). This file is the one list of them. It is cleanup data, not a catalog: nothing
// here is pinned, selectable, installed or recommended, and no code path may download one.
//
// What an upgrade does with a leftover copy, in order:
//   1. `retireModels()` runs once at start: it drops the retired records and manifests, clears a
//      saved choice (the chat model setting) that names one with a plain notice, and removes
//      Splash's hardlinked layout of it (the hardlinks would otherwise keep the disk full).
//   2. Tidy (`GET/POST /stack/v1/components/tidy`, and the start-up storage sweep) then lists the
//      model's own folder and its draft's folder as orphan folders and removes them. A retired
//      folder is recognised by name, so the three-folder and 25 GB safety limit for unknown
//      folders does not apply to it.
export interface RetiredModel { id: string; /** The repository Splash's layout used, so its hub folder can be removed; null when none. */ repo: string | null; retiredOn: string; why: string; }

export const RETIRED_MODELS: readonly RetiredModel[] = [
  { id: "ornith-1-5-122b-mlx-4bit", repo: "ezoushen/ornith-1.5-122b-mlx-4bit", retiredOn: "2026-11-21", why: "Replaced by Flash Next (Max coding and Max chat) and Qwen3.8 27B (everyday coding)." },
  { id: "ornith-1-5-122b-dflash2-draft", repo: "incoai/Ornith-1.5-122B-DFlash2", retiredOn: "2026-11-21", why: "The draft of the retired Ornith 1.5 122B model." },
];

const retiredIds = new Set(RETIRED_MODELS.map((model) => model.id));
export const isRetiredModelId = (id: string): boolean => retiredIds.has(id);
export const retiredModelIds = (): string[] => RETIRED_MODELS.map((model) => model.id);
