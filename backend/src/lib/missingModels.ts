import { existsSync } from "node:fs";
import { join } from "node:path";
import { selectedModel } from "@/lib/supervisor";
import { ROLE_IDS } from "@/roles";
import { getModel } from "@/lib/modelStore";
import { STACK_MODELS, STACK_IMAGE_H3_MODELS, STACK_IMAGE_H3_ID, STACK_VIDEO_H3_MODELS, STACK_VIDEO_H3_MODEL_ID, STACK_VIDEO_MODEL_ID, STACK_VIDEO_TOKENIZER_ID } from "@/lib/modelCatalog";
import { H3_LAYOUT } from "@/images/h3Layout";
import { diskStatus } from "@/lib/disks";

export interface MissingModelFiles { role: string; model: string; part_id: string; override: boolean; missing_paths: string[]; reason?: "drive_not_connected"; fix?: string; drive_label?: string; }
/** Files the selected role model actually reads, following its pinned install layout. */
export function missingModelFiles(): MissingModelFiles[] {
  const result: MissingModelFiles[] = [];
  for (const role of ROLE_IDS) {
    const model = selectedModel(role);
    if (!model) continue;
    const drive = diskStatus(model.diskId);
    if (!drive.connected) { result.push({ role, model: model.id, part_id: model.id, override: false, missing_paths: [], reason: "drive_not_connected", fix: `Plug in ${drive.label} to use ${role}`, drive_label: drive.label }); continue; }
    let required: string[];
    let override = false;
    if (role === "video" && process.env.MAIPAI_H3_VIDEO_HOME && model.id === STACK_VIDEO_H3_MODEL_ID) {
      const home = process.env.MAIPAI_H3_VIDEO_HOME;
      override = true;
      const models = join(home, "models/minimax_h3");
      required = [join(home, "node/scripts/generate_staged.py"), join(home, ".venv/bin/python"), join(models, "upstream/FL2VA"), join(models, "qwen/8-bit"), join(models, "transformers/8-bit")];
    } else {
      const pin = [...STACK_MODELS, ...STACK_IMAGE_H3_MODELS, ...STACK_VIDEO_H3_MODELS].find((candidate) => candidate.id === model.id);
      if (pin && model.id === STACK_IMAGE_H3_ID) {
        required = H3_LAYOUT.map((entry) => getModel(entry.id)?.modelPath ?? "");
      } else if (role === "video" && model.id === STACK_VIDEO_MODEL_ID) {
        const tokenizer = getModel(STACK_VIDEO_TOKENIZER_ID);
        required = [model.modelPath ? join(model.modelPath, "model.safetensors") : "", tokenizer?.modelPath ? join(tokenizer.modelPath, "tokenizer.json") : ""];
      } else if (model.modelPath) {
        const download = pin?.download;
        required = download?.files?.length ? download.files.map((file) => join(model.modelPath!, file.path)) : [model.modelPath];
      } else required = [];
    }
    const missing = required.filter((path) => !existsSync(path));
    if (missing.length) result.push({ role, model: model.id, part_id: model.id, override, missing_paths: missing });
  }
  return result;
}

