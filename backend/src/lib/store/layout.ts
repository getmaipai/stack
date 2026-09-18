import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { dataDir } from "@/lib/paths";

export const storeRoot = join(dataDir, "store");
export const modelsRoot = join(dataDir, "models");
export const hfHubRoot = join(modelsRoot, "hub");
export const modelManifestRoot = join(modelsRoot, "manifests");
export const engineRoot = join(dataDir, "engines");

export function ensureStoreLayout(): void {
  for (const path of [storeRoot, modelsRoot, hfHubRoot, modelManifestRoot, engineRoot]) {
    if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  }
}

export function cacheHome(): string {
  return process.env.HOME ? resolve(process.env.HOME) : homedir();
}

export function hfRepoName(repo: string): string {
  const clean = repo.replace(/^\/+|\/+$/g, "");
  return `models--${clean.replaceAll("/", "--")}`;
}

export function hfRepoRoot(repo: string): string { return join(hfHubRoot, hfRepoName(repo)); }
export function hfBlobsRoot(repo: string): string { return join(hfRepoRoot(repo), "blobs"); }
export function hfRefsRoot(repo: string): string { return join(hfRepoRoot(repo), "refs"); }
export function hfSnapshotsRoot(repo: string): string { return join(hfRepoRoot(repo), "snapshots"); }

export function modelManifestPath(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return join(modelManifestRoot, `${safe}.json`);
}

function currentEngineRoot(): string { return join(resolve(process.env.STACK_DATA_DIR ?? dataDir), "engines"); }
export function engineTagRoot(name: string, tag: string): string { return join(currentEngineRoot(), name, tag); }
export function engineManifestPath(name: string, tag: string): string { return join(engineTagRoot(name, tag), "manifest.json"); }
export function engineCurrentPath(name: string): string { return join(currentEngineRoot(), name, "current"); }

export function externalImportRoots(): Record<string, string> {
  const home = cacheHome();
  return {
    huggingface: join(home, ".cache", "huggingface", "hub"),
    ollama: join(home, ".ollama", "models"),
    "mlx-serve": join(home, ".mlx-serve", "models"),
    omlx: join(home, ".omlx", "models"),
    "lm-studio": join(home, ".lmstudio", "models"),
  };
}
