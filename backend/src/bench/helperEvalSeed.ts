// Seeds a SCRATCH Stack data directory for the Helper eval (docs/helper-bench.md): the Helper's pinned model
// (a link to a file you already have), the two coding models as "installed" with empty stand-in files, and the
// music feature switched off, so the eval has installed-versus-chosen and on-versus-off to ask about.
//
//   STACK_DATA_DIR=/path/to/scratch bun backend/src/bench/helperEvalSeed.ts /path/to/Qwen3-4B-Q4_K_M.gguf
//
// It refuses a data directory that is not under a temporary folder, so it can never touch a live hub.
import { mkdirSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { registerCatalogModel, upsertModel } from "@/lib/modelStore";
import { STACK_CODING_HEAVY_MODEL, STACK_CODING_MODEL, STACK_JUDGE_MODEL } from "@/lib/modelCatalog";
import { updateSettings } from "@/settings";

const helperFile = process.argv[2];
if (!helperFile || !existsSync(helperFile)) throw new Error("Give the path of the Helper's model file (Qwen3-4B-Q4_K_M.gguf).");
const real = realpathSync(dataDir);
const scratch = [realpathSync(tmpdir()), realpathSync("/tmp")].some((root) => real === root || real.startsWith(`${root}/`));
if (!scratch || real.startsWith("/usr/local/maipai-home")) throw new Error(`Refusing to seed ${dataDir}: it is not a scratch data directory.`);
const now = new Date().toISOString();
const install = (model: Parameters<typeof registerCatalogModel>[0], path: string) => {
  const record = registerCatalogModel(model);
  upsertModel({ ...record, installedAt: now, verifiedAt: now, modelPath: path });
};
const helperDir = join(dataDir, "models", STACK_JUDGE_MODEL.id);
mkdirSync(helperDir, { recursive: true });
const helperLink = join(helperDir, "model.gguf");
if (!existsSync(helperLink)) symlinkSync(helperFile, helperLink);
install(STACK_JUDGE_MODEL, helperLink);
for (const m of [STACK_CODING_MODEL, STACK_CODING_HEAVY_MODEL]) {
  const dir = join(dataDir, "models", m.id);
  mkdirSync(dir, { recursive: true });
  const stand = join(dir, "stand-in.gguf");
  writeFileSync(stand, "");
  install(m, m.id === STACK_CODING_HEAVY_MODEL.id ? dir : stand);
}
updateSettings({ "stack.roles.music.enabled": false });
console.log(`Seeded ${dataDir}`);
