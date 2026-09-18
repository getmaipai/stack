import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_BINARIES, ENGINE_READY_MARKER } from "@/lib/engineCatalog";
import { listModels } from "@/lib/modelStore";
import { sha256OfPath } from "@/lib/store/blobs";
import { engineRoot, engineTagRoot, ensureStoreLayout } from "@/lib/store/layout";
import { writeEngineManifest, writeModelManifest } from "@/lib/store/manifests";
import { log } from "@/lib/log";

function engineNameTag(id: string): { name: string; tag: string } {
  const marker = id.indexOf("-b");
  return marker > 0 ? { name: id.slice(0, marker), tag: id.slice(marker + 1) } : { name: id, tag: "legacy" };
}

export function migrateLegacyStore(): void {
  ensureStoreLayout();
  if (existsSync(engineRoot)) {
    for (const entry of readdirSync(engineRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const legacyPath = join(engineRoot, entry.name);
      if (!existsSync(join(legacyPath, ENGINE_READY_MARKER))) continue;
      const pin = ENGINE_BINARIES.find((candidate) => candidate.id === entry.name);
      if (!pin) continue;
      const { name, tag } = engineNameTag(pin.id);
      const destination = engineTagRoot(name, tag);
      if (!existsSync(destination)) {
        mkdirSync(join(engineRoot, name), { recursive: true, mode: 0o700 });
        renameSync(legacyPath, destination);
        log("Migrated legacy engine %s to %s", entry.name, destination);
      }
      writeEngineManifest({ kind: "engine", name, tag, assetUrl: pin.archive.url, sizeBytes: pin.archive.approxBytes, sha256: pin.archive.sha256, extractedAt: new Date().toISOString(), blobs: [] });
    }
  }
  for (const model of listModels()) {
    if (!model.modelPath || !existsSync(model.modelPath) || !statSync(model.modelPath).isFile()) continue;
    const digest = model.sha256 ?? sha256OfPath(model.modelPath);
    writeModelManifest({ kind: "model", id: model.id, source: model.source, sourcePath: model.modelPath, revision: model.revision, roles: model.roles, blobs: [{ digest, sizeBytes: statSync(model.modelPath).size, path: model.modelPath }], sizeBytes: statSync(model.modelPath).size, createdAt: model.installedAt ?? new Date().toISOString() });
  }
}
