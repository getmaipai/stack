// H3-IMAGE-STACK-01: the folder the h3-image-mlx runner reads (`--models <dir>`). The five pinned files live in the hub cache, two
// repositories at two revisions, and the runner wants one tree:
//   diffusion_models/<dit>.safetensors  text_encoders/<encoder>.safetensors  vae/<vae>.safetensors  vae/config.json  tokenizer.json
// so the folder is a set of symbolic links to the verified files, rebuilt before each run (cheap, and never a second copy of 49 GB).
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { H3_IMAGE_FILES, H3_IMAGE_PRIMARY } from "@/images/pins";
import { STACK_IMAGE_H3_ID } from "@/lib/modelCatalog";

/** The catalog record id of each pinned file, with where the runner expects it. */
export const H3_LAYOUT: Array<{ id: string; layout: string }> = H3_IMAGE_FILES.map((file) => ({ id: file.file === H3_IMAGE_PRIMARY ? STACK_IMAGE_H3_ID : `${STACK_IMAGE_H3_ID}-${file.part}`, layout: file.layout }));

/** Links every file into `dir` and returns it, or null when a file is missing (nothing half-built is left behind). */
export function buildH3ModelsDir(dir: string, resolve: (recordId: string) => string | null): string | null {
  const targets = H3_LAYOUT.map((entry) => ({ ...entry, path: resolve(entry.id) }));
  if (targets.some((entry) => !entry.path || !existsSync(entry.path))) return null;
  rmSync(dir, { recursive: true, force: true });
  for (const entry of targets) {
    const link = join(dir, entry.layout);
    mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
    symlinkSync(entry.path!, link);
  }
  return dir;
}
