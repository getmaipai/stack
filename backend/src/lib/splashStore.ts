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
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { dataDir } from "@/lib/paths";
import { currentEngineBinary, engineBinaryPath, engineDir } from "@/lib/engineInstall";
import { ENGINE_READY_MARKER, installedEnginePin } from "@/lib/engineCatalog";
import { getModel, type CatalogModelLike, type ModelRecord } from "@/lib/modelStore";
import { STACK_CODING_DRAFT_MODEL, STACK_CODING_MODEL, STACK_CODING_HEAVY_MODEL, STACK_CODING_HEAVY_DRAFT_MODEL, STACK_CHAT_QWEN38_UNCENSORED_MODEL, STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_MODEL, STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_DRAFT } from "@/lib/modelCatalog";

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

/** The target and draft pins a Splash launch for this model id lays out. */
export function splashPairFor(modelId: string): { pin: CatalogModelLike; draftPin: CatalogModelLike } {
  if (modelId === STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_MODEL.id) return { pin: STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_MODEL, draftPin: STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_DRAFT };
  if (modelId === STACK_CHAT_QWEN38_UNCENSORED_MODEL.id) return { pin: STACK_CHAT_QWEN38_UNCENSORED_MODEL, draftPin: STACK_CODING_DRAFT_MODEL };
  return modelId === STACK_CODING_HEAVY_MODEL.id ? { pin: STACK_CODING_HEAVY_MODEL, draftPin: STACK_CODING_HEAVY_DRAFT_MODEL } : { pin: STACK_CODING_MODEL, draftPin: STACK_CODING_DRAFT_MODEL };
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

const MOE_ID = STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_MODEL.id;

/** The folders a Splash process needs without a hub layout: state, hub cache and temporary space (the temporary one emptied). */
export function splashDirs(): { hubDir: string; homeDir: string; tmpDir: string } {
  mkdirSync(splashHubDir(), { recursive: true, mode: 0o700 });
  mkdirSync(splashHomeDir(), { recursive: true, mode: 0o700 });
  rmSync(splashTmpDir(), { recursive: true, force: true });
  mkdirSync(splashTmpDir(), { recursive: true, mode: 0o700 });
  return { hubDir: splashHubDir(), homeDir: splashHomeDir(), tmpDir: splashTmpDir() };
}

/** Where Splash keeps prepared models for its HOME (`Path.home() / Library/Application Support/Splash/models`). */
export const splashModelsDir = (): string => join(splashHomeDir(), "Library", "Application Support", "Splash", "models");
/** The note the install leaves: the pins prepared and the folder Splash returned. */
export const splashPreparedNotePath = (): string => join(splashRoot(), "prepared-qwen36-35b.json");

/** What `--model-dir` and `--draft-model` name for the 35B: its verified GGUF file and its draft folder. Splash refuses a hand-built model folder (it derives the config and tokenizer from the GGUF), so the launch hands it these two paths and Splash prepares the folder itself, reading only file metadata once the install has prepared it. */
export function splashLocalModelFor(modelId: string, lookup: (id: string) => ModelRecord | null = getModel): { modelDir: string; draftDir: string; model: string } | null {
  if (modelId !== MOE_ID) return null;
  const target = lookup(MOE_ID);
  const draft = lookup(STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_DRAFT.id);
  if (!target?.modelPath || !existsSync(target.modelPath)) throw new SplashLayoutError("The chat model file is missing. Install it again from Settings.");
  if (!draft?.modelPath || !existsSync(draft.modelPath)) throw new SplashLayoutError("The chat model's speed-up files are missing. Install them again from Settings.");
  return { modelDir: target.modelPath, draftDir: draft.modelPath, model: STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_MODEL.repo! };
}

const pinsKey = (): { target: string; draft: string } => ({
  target: `${STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_MODEL.revision}:${STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_MODEL.download!.sha256}`,
  draft: `${STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_DRAFT.revision}:${STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_DRAFT.download!.sha256}`,
});
function preparedNote(): { target?: string; draft?: string; prepared?: string } | null {
  try { return JSON.parse(readFileSync(splashPreparedNotePath(), "utf8")); } catch { return null; }
}
/** Whether the note says the folder for the current pins exists. */
export function splashPreparedCurrent(): boolean {
  const note = preparedNote();
  const key = pinsKey();
  return !!note && note.target === key.target && note.draft === key.draft && !!note.prepared && existsSync(note.prepared);
}

export interface PrepareRun { code: number; out: string; err: string }
export type PrepareRunner = (command: string[], options: { cwd: string; env: Record<string, string> }) => Promise<PrepareRun>;
const spawnRunner: PrepareRunner = async (command, options) => {
  const child = Bun.spawn(command, { cwd: options.cwd, env: options.env, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err };
};

/** Install step after the target and draft verify: Splash's own installer prepares the model folder once (it hashes the 21 GB file once), with Splash's HOME, so the launch finds it. Runs again when a pin changes; does nothing when the folder for the current pins exists. Throws SplashLayoutError in plain words. */
export async function prepareSplashModel(run: PrepareRunner = spawnRunner): Promise<boolean> {
  const target = STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_MODEL;
  const draftPin = STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_DRAFT;
  const targetRecord = getModel(target.id);
  const draftRecord = getModel(draftPin.id);
  if (!targetRecord?.modelPath || !targetRecord.verifiedAt || targetRecord.sha256?.toLowerCase() !== target.download!.sha256.toLowerCase() || targetRecord.revision !== target.revision || !existsSync(targetRecord.modelPath)) throw new SplashLayoutError("Splash needs the pinned, verified chat model before preparation.");
  if (!draftRecord?.modelPath || !draftRecord.verifiedAt || draftRecord.revision !== draftPin.revision || !existsSync(draftRecord.modelPath)) throw new SplashLayoutError("Splash needs the pinned, verified DFlash2 draft before preparation.");
  // The engine may arrive after the model: then the launch's own preparation (same Splash call) does it at the first start, and this step has nothing to do yet.
  const launcher = splashChatBinary();
  if (!launcher) return false;
  if (splashPreparedCurrent()) return true;
  const root = dirname(dirname(launcher));
  const python = join(root, "python", "bin", "python3");
  const dirs = splashDirs();
  const models = splashModelsDir();
  mkdirSync(models, { recursive: true, mode: 0o700 });
  const script = "import sys; from install.local import prepare_local_model; print(prepare_local_model(sys.argv[1], draft=sys.argv[2], models_dir=sys.argv[3]))";
  const env: Record<string, string> = { HOME: dirs.homeDir, TMPDIR: dirs.tmpDir, HF_HOME: dirs.homeDir, HF_HUB_CACHE: dirs.hubDir, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", DO_NOT_TRACK: "1", PYTHONUNBUFFERED: "1", PYTHONPATH: root, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  const result = await run([python, "-P", "-c", script, targetRecord.modelPath, draftRecord.modelPath, models], { cwd: root, env });
  const prepared = result.out.trim().split("\n").pop() ?? "";
  if (result.code !== 0 || !prepared.startsWith("/")) throw new SplashLayoutError(`Splash could not prepare the chat model: ${(result.err || result.out).trim().split("\n").slice(-3).join(" | ") || "no reason given"}. Install it again from Settings.`);
  writeFileSync(splashPreparedNotePath(), JSON.stringify({ ...pinsKey(), prepared }), { mode: 0o600 });
  return true;
}

/** The installed Splash chat engine's launcher binary: the `current` build, or the machine's pinned build before any swap (the supervisor's rule). */
function splashChatBinary(): string | null {
  const current = currentEngineBinary("splash-chat", "engine/splash");
  if (current.state === "ready") return current.path;
  if (current.state === "unready") return null;
  const pin = installedEnginePin("splash-chat");
  return pin && existsSync(join(engineDir(pin), ENGINE_READY_MARKER)) ? engineBinaryPath(pin) : null;
}

/** Removal cleanup for the 35B: the folder Splash prepared and the install's note. */
export function removePreparedSplashModel(): void {
  const note = preparedNote();
  if (note?.prepared && note.prepared.startsWith(splashModelsDir())) rmSync(note.prepared, { recursive: true, force: true });
  rmSync(splashPreparedNotePath(), { force: true });
}

/** The coding model and its draft are the only ids whose removal affects the layout. */
export function releaseSplashLayoutFor(id: string): void {
  if (id === MOE_ID || id === STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_DRAFT.id) { removePreparedSplashModel(); return; }
  if (![STACK_CODING_MODEL.id, STACK_CODING_DRAFT_MODEL.id, STACK_CODING_HEAVY_MODEL.id, STACK_CODING_HEAVY_DRAFT_MODEL.id, STACK_CHAT_QWEN38_UNCENSORED_MODEL.id].includes(id)) return;
  try { rmSync(splashRoot(), { recursive: true, force: true }); } catch { /* a running engine's folder may refuse; the next layout repairs it */ }
}
