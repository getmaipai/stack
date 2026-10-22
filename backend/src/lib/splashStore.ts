// Splash's files, all inside the Stack's data directory (CODE-STACK-01 S5a).
//
// What was found by reading Splash 1.3.2's launcher and server and by one real run
// under a loopback-only sandbox (docs/dev.md, S5a): Splash needs no download of its
// own when three things are true. (1) A Hugging Face hub cache, named by
// HF_HUB_CACHE, holds the target and the draft in the hub's own layout
// (`models--<owner>--<repo>/{blobs/<sha256>,snapshots/<commit>/<file>,refs/main}`).
// (2) The target is named by its commit (`--revision`), the draft by `refs/main`.
// (3) `HOME` points at a folder of the Stack's, where Splash keeps its assembled
// model links (`Library/Application Support/Splash`), its locks and its crash logs;
// `TMPDIR` points at another, where its SSD cache files go. With `--offline` and
// `HF_HUB_OFFLINE=1` a fresh state folder assembled the model in about 8 seconds
// with every network connection denied.
//
// So the Stack lays that cache out itself from the files it already pinned and
// verified, by hardlink (never a copy: a second 16 GB file would be a second 16 GB),
// and Splash only ever reads them. The blob is named by its sha256, which is what the
// hub names an LFS file, so Splash does not hash 16 GB again to describe it.
// If the data directory cannot hold a hardlink (two volumes) a symlink is used, which
// works but makes Splash hash the file once when it assembles.
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { dataDir } from "@/lib/paths";
import type { CatalogModelLike, ModelRecord } from "@/lib/modelStore";
import { STACK_CODING_DRAFT_MODEL, STACK_CODING_MODEL, STACK_CODING_HEAVY_MODEL, STACK_CODING_HEAVY_DRAFT_MODEL } from "@/lib/modelCatalog";

export const splashRoot = (): string => join(dataDir, "splash");
/** The hub cache Splash reads (HF_HUB_CACHE): the Stack's own layout of the pinned files, not the store's `models/hub`. */
export const splashHubDir = (): string => join(splashRoot(), "hub");
/** HOME for the Splash process: its model links, runtime locks, crash logs and thinking key live here. */
export const splashHomeDir = (): string => join(splashRoot(), "home");
/** TMPDIR for the Splash process: its SSD cache files; emptied at every launch. */
export const splashTmpDir = (): string => join(splashRoot(), "tmp");

/** Plain-words refusal: the Splash start cannot lay its files out. The supervisor falls back to llama-server and says this. */
export class SplashLayoutError extends Error {
  constructor(message: string) { super(message); this.name = "SplashLayoutError"; }
}

export interface SplashLayout {
  hubDir: string;
  homeDir: string;
  tmpDir: string;
  /** `--model` for the target: `<owner>/<repo>:<variant>`. */
  model: string;
  /** `--revision`: the target's commit. */
  revision: string;
  /** How each blob was placed: a hardlink unless the volume refused one. */
  placed: Array<{ file: string; how: "hardlink" | "symlink" }>;
}

interface LayoutFile { name: string; sha256: string; bytes: number; source: string; }
interface LayoutRepo { repo: string; revision: string; files: LayoutFile[]; }

const hubFolder = (repo: string): string => join(splashHubDir(), `models--${repo.replace(/^\/+|\/+$/g, "").replaceAll("/", "--")}`);
const urlFileName = (url: string): string => basename(new URL(url).pathname);

/** The two repositories the pins describe, resolved against the store's records (`getModel` is the store's lookup, passed in so this file never imports the store at run time). Refuses, in plain words, when a pin is missing, differs from what is installed, or has a file of the wrong size. */
export function splashRepositories(getModel: (id: string) => ModelRecord | null, pin: CatalogModelLike = STACK_CODING_MODEL, draftPin: CatalogModelLike = STACK_CODING_DRAFT_MODEL): { target: LayoutRepo; draft: LayoutRepo; variant: string } {
  const model = getModel(pin.id);
  if (!model?.modelPath || !model.verifiedAt || !existsSync(model.modelPath)) throw new SplashLayoutError(`The coding model (${pin.id}) is not installed and verified, so Splash has nothing to load. Install the coding model from Settings, then send the request again.`);
  if (model.sha256?.toLowerCase() !== pin.download!.sha256.toLowerCase() || model.revision !== pin.revision) throw new SplashLayoutError(`The coding model on this computer is not the pinned ${pin.id} (revision ${pin.revision?.slice(0, 8)}), so Splash will not load it. Install the coding model again from Settings.`);
  const draft = getModel(draftPin.id);
  if (!draft?.modelPath || !draft.verifiedAt || !existsSync(draft.modelPath)) throw new SplashLayoutError(`Splash's draft model (${draftPin.id}, ${(draftPin.download!.approx_bytes / 1e9).toFixed(1)} GB) is not installed, so the coding model runs on llama-server. Install the coding model again from Settings to add it.`);
  if (draft.sha256?.toLowerCase() !== draftPin.download!.sha256.toLowerCase() || draft.revision !== draftPin.revision) throw new SplashLayoutError(`Splash's draft model on this computer is not the pinned ${draftPin.id}, so the coding model runs on llama-server. Install the coding model again from Settings.`);
  const targetFiles = pin.download!.files?.map((file): LayoutFile => {
    const source = join(model.modelPath!, file.path);
    if (!existsSync(source) || statSync(source).size !== file.bytes) throw new SplashLayoutError(`Splash's ${pin.id} file ${file.path} is missing or the wrong size, so Splash cannot load this model. Install the coding model again from Settings.`);
    return { name: file.path, sha256: file.sha256.toLowerCase(), bytes: file.bytes, source };
  });
  if (!targetFiles) {
    const targetSize = statSync(model.modelPath).size;
    if (targetSize !== pin.download!.approx_bytes) throw new SplashLayoutError(`The ${pin.id} file is ${targetSize} bytes but the pin says ${pin.download!.approx_bytes}, so it is not the file that was verified. Install the coding model again from Settings.`);
  }
  const draftFiles = draftPin.download!.files!.map((file): LayoutFile => {
    const source = join(draft.modelPath!, file.path);
    if (!existsSync(source) || statSync(source).size !== file.bytes) throw new SplashLayoutError(`Splash's draft file ${file.path} is missing or the wrong size, so the coding model runs on llama-server. Install the coding model again from Settings.`);
    return { name: file.path, sha256: file.sha256.toLowerCase(), bytes: file.bytes, source };
  });
  const quantization = (pin.sizing as { quantization?: string }).quantization;
  if (!pin.repo || !pin.revision || !draftPin.repo || !draftPin.revision || !quantization) throw new SplashLayoutError("The coding pins are incomplete.");
  return {
    variant: quantization,
    target: { repo: pin.repo, revision: pin.revision, files: targetFiles ?? [{ name: urlFileName(pin.download!.url), sha256: pin.download!.sha256.toLowerCase(), bytes: pin.download!.approx_bytes, source: model.modelPath }] },
    draft: { repo: draftPin.repo, revision: draftPin.revision, files: draftFiles },
  };
}

function sameFile(a: string, b: string): boolean {
  try { const left = statSync(a); const right = statSync(b); return left.ino === right.ino && left.dev === right.dev; } catch { return false; }
}

/** One blob in place under `blobs/<sha256>`: the pinned file, linked. */
function placeBlob(source: string, blob: string): "hardlink" | "symlink" {
  mkdirSync(dirname(blob), { recursive: true, mode: 0o700 });
  let kind: "hardlink" | "symlink" | null = null;
  try {
    const existing = lstatSync(blob);
    if (sameFile(source, blob)) kind = existing.isSymbolicLink() ? "symlink" : "hardlink";
    else unlinkSync(blob);
  } catch { /* nothing there yet */ }
  if (kind) return kind;
  try { linkSync(source, blob); return "hardlink"; } catch { /* two volumes, or a file system without hard links */ }
  try { symlinkSync(source, blob); return "symlink"; } catch (error) {
    throw new SplashLayoutError(`Splash's files could not be linked into ${dirname(dirname(blob))} (${(error as NodeJS.ErrnoException).code ?? "error"}), so the coding model runs on llama-server. Check that the Stack may write to its data folder.`);
  }
}

function layOutRepo(repo: LayoutRepo, placed: SplashLayout["placed"]): void {
  const folder = hubFolder(repo.repo);
  const blobs = join(folder, "blobs");
  const snapshot = join(folder, "snapshots", repo.revision);
  mkdirSync(snapshot, { recursive: true, mode: 0o700 });
  for (const file of repo.files) {
    const blob = join(blobs, file.sha256);
    placed.push({ file: `${repo.repo}/${file.name}`, how: placeBlob(file.source, blob) });
    const link = join(snapshot, file.name);
    const target = relative(dirname(link), blob);
    let current: string | null = null;
    try { current = readlinkSync(link); } catch { /* absent */ }
    if (current !== target) {
      mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
      try { unlinkSync(link); } catch { /* absent */ }
      symlinkSync(target, link);
    }
  }
  mkdirSync(join(folder, "refs"), { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, "refs", "main"), repo.revision);
  // Anything else in these two folders is from an earlier pin: its snapshots and its blobs go, so the cache holds exactly what is pinned.
  const keepBlobs = new Set(repo.files.map((file) => file.sha256));
  for (const name of existsSync(join(folder, "snapshots")) ? readdirSync(join(folder, "snapshots")) : []) if (name !== repo.revision) rmSync(join(folder, "snapshots", name), { recursive: true, force: true });
  for (const name of existsSync(blobs) ? readdirSync(blobs) : []) if (!keepBlobs.has(name)) rmSync(join(blobs, name), { force: true });
}

/** Lays the pinned target and draft out as Splash's hub cache, creates its state and temporary folders (the temporary one emptied), and returns what the launch needs. Idempotent and cheap: stat calls and a few links. Throws SplashLayoutError, in plain words, when it cannot. */
export function layOutSplashCache(getModel: (id: string) => ModelRecord | null, pin: CatalogModelLike = STACK_CODING_MODEL, draftPin: CatalogModelLike = STACK_CODING_DRAFT_MODEL): SplashLayout {
  const { target, draft, variant } = splashRepositories(getModel, pin, draftPin);
  const placed: SplashLayout["placed"] = [];
  mkdirSync(splashHubDir(), { recursive: true, mode: 0o700 });
  layOutRepo(target, placed);
  layOutRepo(draft, placed);
  mkdirSync(splashHomeDir(), { recursive: true, mode: 0o700 });
  // The SSD cache files of an earlier run are not worth keeping and are never reused (no --persistent-cache).
  rmSync(splashTmpDir(), { recursive: true, force: true });
  mkdirSync(splashTmpDir(), { recursive: true, mode: 0o700 });
  return { hubDir: splashHubDir(), homeDir: splashHomeDir(), tmpDir: splashTmpDir(), model: pin.download?.files ? target.repo : `${target.repo}:${variant}`, revision: target.revision, placed };
}

/** The coding model and its draft are the only ids whose removal affects the layout. */
export function releaseSplashLayoutFor(id: string): void {
  if (![STACK_CODING_MODEL.id, STACK_CODING_DRAFT_MODEL.id, STACK_CODING_HEAVY_MODEL.id, STACK_CODING_HEAVY_DRAFT_MODEL.id].includes(id)) return;
  try { rmSync(splashRoot(), { recursive: true, force: true }); } catch { /* a running engine's folder may refuse; the next layout repairs it */ }
}
