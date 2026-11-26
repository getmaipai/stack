// The model relationship map: ONE definition of what DRIVES a model (the engine that runs it) and what EXTENDS it (a speed draft, a vision
// projector, a LoRA style), plus who owns each top-level data folder. It adds no second copy of any fact: every link is read from the rows
// that already say it (a model pin's `engine`, `companions`, `imageInput.projector`, `superseded_by`; a LoRA's `base_model`), and
// `rows/dataFolders.json` is the one new row file (folder to owner). Pure: no database, no disk. `relationshipsLive.ts` feeds it the real state.
import folderRows from "@/rows/dataFolders.json";

export type LinkKind = "driven_by" | "draft" | "vision" | "style" | "replaced_by";
/** `from` needs or is extended by `to`, per kind: driven_by (from runs on engine `to`), draft/vision (from is the base and `to` extends it), style (LoRA `from` extends base `to`), replaced_by (`to` replaces `from`). */
export interface Link { from: string; to: string; kind: LinkKind }
export interface PinFacts { id: string; engine?: string; companions?: string[]; imageInput?: { projector: string }; superseded_by?: string[] }
export interface LoraFacts { id: string; base_model: string }
export type Action = "delete" | "move" | "upgrade";
export interface Note { id: string; label: string; why: string }
export interface Impact { id: string; action: Action; blocking: Note[]; warnings: Note[] }
export interface Owner { kind: "engine" | "engines" | "models" | "feature" | "stack"; id: string }
export interface FolderRow { path: string; owner: Owner; label: string }
export interface Facts {
  pins: PinFacts[]; loras: LoraFacts[];
  /** LoRA base name to the model id that carries it. */
  loraBases: Record<string, string>;
  installed: (id: string) => boolean;
  /** Chosen for a role or loaded in a process right now. */
  inUse: (id: string) => boolean;
  label?: (id: string) => string;
  /** The model's file sits in the shared hub-cache layout (`download.hub_file`), which an engine links into. */
  hubLayout?: (id: string) => boolean;
}

export const DATA_FOLDERS: FolderRow[] = folderRows as FolderRow[];

export function buildLinks(facts: Pick<Facts, "pins" | "loras" | "loraBases">): Link[] {
  const links: Link[] = [];
  for (const pin of facts.pins) {
    if (pin.engine) links.push({ from: pin.id, to: pin.engine, kind: "driven_by" });
    for (const id of pin.companions ?? []) links.push({ from: pin.id, to: id, kind: "draft" });
    if (pin.imageInput) links.push({ from: pin.id, to: pin.imageInput.projector, kind: "vision" });
    for (const id of pin.superseded_by ?? []) links.push({ from: pin.id, to: id, kind: "replaced_by" });
  }
  // An extender runs on its base's engine: the draft and projector share it, so a delete or upgrade of the engine names them too.
  for (const pin of facts.pins) for (const link of links.filter((item) => item.from === pin.id && (item.kind === "draft" || item.kind === "vision"))) {
    if (pin.engine) links.push({ from: link.to, to: pin.engine, kind: "driven_by" });
  }
  for (const lora of facts.loras) { const base = facts.loraBases[lora.base_model]; if (base) links.push({ from: lora.id, to: base, kind: "style" }); }
  const seen = new Set<string>();
  return links.filter((link) => { const key = `${link.from}|${link.kind}|${link.to}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

const nameOf = (facts: Facts, id: string): string => facts.label?.(id) ?? id;
const EXTENDS: LinkKind[] = ["draft", "vision"];

/** What a delete, move or upgrade of `id` touches. `blocking`: something installed and in use depends on it (refuse). `warnings`: other installed things that go along or break (say so first). */
export function impactOf(facts: Facts, id: string, action: Action, links: Link[] = buildLinks(facts)): Impact {
  const blocking: Note[] = []; const warnings: Note[] = [];
  const add = (list: Note[], other: string, why: string): void => { if (!list.some((note) => note.id === other && note.why === why)) list.push({ id: other, label: nameOf(facts, other), why }); };
  const self = nameOf(facts, id);
  // Things that run on `id` (it is an engine) or are extended-by-it (it is a draft, projector or base model).
  const runsOn = links.filter((link) => link.kind === "driven_by" && link.to === id).map((link) => link.from);
  const baseOfThis = links.filter((link) => EXTENDS.includes(link.kind) && link.to === id).map((link) => ({ base: link.from, kind: link.kind }));
  const extenders = links.filter((link) => EXTENDS.includes(link.kind) && link.from === id).map((link) => ({ ext: link.to, kind: link.kind }));
  const styles = links.filter((link) => link.kind === "style" && link.to === id).map((link) => link.from);

  for (const model of runsOn) if (facts.installed(model)) {
    if (action === "upgrade") add(warnings, model, `${nameOf(facts, model)} runs on ${self}; it is restarted on the new build.`);
    else if (action === "delete") add(facts.inUse(model) ? blocking : warnings, model, `${nameOf(facts, model)} runs on ${self}${facts.inUse(model) ? " and is in use now" : ""}.`);
  }
  for (const { base, kind } of baseOfThis) if (facts.installed(base) && action !== "upgrade") {
    const what = kind === "draft" ? "speed draft" : "vision add-on";
    add(facts.inUse(base) ? blocking : warnings, base, `${self} is the ${what} of ${nameOf(facts, base)}${facts.inUse(base) ? ", which is in use now" : ""}; ${nameOf(facts, base)} loses it.`);
  }
  for (const { ext, kind } of extenders) if (facts.installed(ext)) {
    const what = kind === "draft" ? "speed draft" : "vision add-on";
    if (action === "delete") add(warnings, ext, `Its ${what} ${nameOf(facts, ext)} goes with it.`);
    else if (action === "move") add(warnings, ext, `Its ${what} ${nameOf(facts, ext)} stays where it is; move it too.`);
    else add(warnings, ext, `Its ${what} ${nameOf(facts, ext)} must match the new version.`);
  }
  for (const style of styles) {
    if (action === "delete") add(warnings, style, `The style ${nameOf(facts, style)} needs ${self} and stops working.`);
    if (action === "upgrade") add(warnings, style, `The style ${nameOf(facts, style)} was made for this version and may need re-checking.`);
  }
  if (action === "move") {
    if (facts.hubLayout?.(id)) add(blocking, id, `${self} lives in the shared hub layout that its engine links into; moving the file alone breaks those links. Move it with its engine's data instead.`);
  }
  return { id, action, blocking, warnings };
}

export function ownerOfFolder(path: string, rows: FolderRow[] = DATA_FOLDERS): FolderRow | null {
  const top = path.replace(/^\/+/, "").split("/")[0] ?? "";
  return rows.find((row) => row.path === top) ?? null;
}
