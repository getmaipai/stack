import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { sha256OfPath, linkOrCopy } from "@/lib/store/blobs";
import { externalImportRoots, modelManifestPath } from "@/lib/store/layout";
import { scanHfCache } from "@/lib/store/hfCache";
import { writeModelManifest, type ModelManifest, type StoreBlob } from "@/lib/store/manifests";

export type ImportSource = "huggingface" | "ollama" | "mlx-serve" | "omlx" | "lm-studio";

export interface ImportCandidate {
  source: ImportSource;
  path: string;
  digest: string;
  sizeBytes: number;
  name: string;
  repo?: string;
  revision?: string;
}

const MODEL_EXTENSIONS = new Set([".gguf", ".safetensors", ".bin", ".pt", ".pth", ".mlx", ".onnx"]);

function candidate(source: ImportSource, path: string, name = basename(path)): ImportCandidate {
  return { source, path, digest: sha256OfPath(path), sizeBytes: statSync(path).size, name };
}

function scanFiles(root: string, source: ImportSource): ImportCandidate[] {
  if (!existsSync(root)) return [];
  const results: ImportCandidate[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && (MODEL_EXTENSIONS.has(path.slice(path.lastIndexOf(".")).toLowerCase()) || source === "ollama")) results.push(candidate(source, path));
    }
  };
  walk(root);
  return results;
}

export function scanImports(roots: Partial<Record<ImportSource, string>> = externalImportRoots()): ImportCandidate[] {
  const result: ImportCandidate[] = [];
  const hf = roots.huggingface;
  if (hf) for (const file of scanHfCache(hf)) result.push({ source: "huggingface", path: file.path, digest: file.digest, sizeBytes: file.sizeBytes, name: file.filePath, repo: file.repo, revision: file.revision });
  for (const source of ["ollama", "mlx-serve", "omlx", "lm-studio"] as const) {
    const root = roots[source];
    if (root) result.push(...scanFiles(root, source));
  }
  return result;
}

export interface ImportOneOptions {
  id: string;
  roles: string[];
  licence?: string;
  revision?: string;
}

export function importCandidate(item: ImportCandidate, options: ImportOneOptions): ModelManifest {
  const id = options.id;
  const destination = join(dirname(modelManifestPath(id)), "imports", id, basename(item.path));
  const mode = linkOrCopy(item.path, destination);
  const blob: StoreBlob = { digest: item.digest, sizeBytes: item.sizeBytes, path: destination, shared: mode !== "copy" };
  const manifest: ModelManifest = {
    kind: "model", id, source: item.source, sourcePath: item.path,
    repo: item.repo, revision: options.revision ?? item.revision ?? "import",
    roles: options.roles, blobs: [blob], sizeBytes: item.sizeBytes, createdAt: new Date().toISOString(),
  };
  writeModelManifest(manifest);
  return manifest;
}

export function importPath(path: string, options: ImportOneOptions): ModelManifest {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Import path is not a file: ${path}`);
  return importCandidate(candidate("lm-studio", path), options);
}
