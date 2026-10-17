// Measures what installs take on disk and writes src/lib/diskPlanMeasured.json,
// the table lib/diskPlan.ts reads. Run on a real install (the default paths
// are this Mac's live Stack and Home; override with STACK_DATA_DIR and
// HOME_INSTALL_ROOT), then commit the file. tests/diskPlan.test.ts fails
// when a pin's byte count changes and this table is not regenerated.
//   bun run measure:disk-plan
import { existsSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// modelCatalog.ts reaches the database through hf.ts: never open a real data directory.
const scratch = mkdtempSync(join(tmpdir(), "maipai-stack-disk-plan-"));
const dataDirectory = process.env.STACK_DATA_DIR ?? "/usr/local/maipai-home/stack/data";
const homeRoot = process.env.HOME_INSTALL_ROOT ?? "/usr/local/maipai-home";
process.env.STACK_DATA_DIR = scratch;
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const { STACK_MODELS } = await import("../src/lib/modelCatalog");

/** Blocks on disk (what `du` reports), in bytes. */
const duBytes = (path: string): number => { const out = Bun.spawnSync(["du", "-sk", path], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim(); return Number(out.split(/\s+/)[0]) * 1024; };
/** The sum of file sizes under a path (a model is stored byte for byte; an archive unpacks to more). */
function apparent(path: string): number {
  if (!existsSync(path)) return 0;
  const info = statSync(path);
  return info.isDirectory() ? readdirSync(path).reduce((sum, name) => sum + apparent(join(path, name)), 0) : info.size;
}

const pins: Record<string, { download_bytes: number; installed_bytes: number }> = {};
for (const pin of STACK_MODELS) {
  const download = pin.download?.approx_bytes ?? 0;
  // Only an archive is bigger on disk than its download: measure its unpacked folder when this machine has it.
  const folder = join(dataDirectory, "models", pin.id);
  const installed = pin.download?.archive && existsSync(folder) ? apparent(folder) : download;
  pins[pin.id] = { download_bytes: download, installed_bytes: Math.max(installed, download) };
}

const engineDir = join(dataDirectory, "engines");
const env = (name: string, version: string) => duBytes(join(engineDir, name, version));
const envNames: Array<[string, string, string]> = [["pocket-tts", "pocket-tts", "3.1.0"], ["mlx-audio", "mlx-audio", "0.5.9"], ["image-gen", "image-gen", "0.23.0"], ["image-tools", "image-tools", "1.0.0"], ["video-gen", "video-gen", "87db56a"], ["music-gen", "music-gen", "ca1e85f"], ["omlx", "omlx", "0.7.0"]];
const installed = Object.fromEntries(envNames.map(([key, name, version]) => [key, env(name, version)]));
// uv keeps the wheels it downloaded in one cache; the cache over the environments it built is the share each environment downloads and keeps until the install ends.
const cache = duBytes(join(engineDir, "uv", "cache"));
const ratio = cache / Object.values(installed).reduce((sum, bytes) => sum + bytes, 0);
const engines: Record<string, { installed_bytes: number; download_bytes: number; peak_temp_bytes: number; basis: string }> = {};
for (const [key] of envNames) {
  const download = Math.round(installed[key]! * ratio);
  engines[key] = { installed_bytes: installed[key]!, download_bytes: download, peak_temp_bytes: download, basis: "measured" };
}
const python = duBytes(join(engineDir, "uv", "0.12.17")) + duBytes(join(engineDir, "uv", "python"));
engines["python-base"] = { installed_bytes: python, download_bytes: python, peak_temp_bytes: 0, basis: "measured" };
const search = duBytes(join(engineDir, "ddgs-sidecar", "9.16.0"));
engines["search-helper"] = { installed_bytes: search, download_bytes: search, peak_temp_bytes: 0, basis: "measured" };
// Home itself: the install folder without the Stack's data (du of the root less data/ and stack/data), plus the llama.cpp server.
const homeInstalled = duBytes(homeRoot) - duBytes(join(homeRoot, "stack", "data")) - duBytes(join(homeRoot, "data")) + duBytes(join(engineDir, "llama-server", "b10797"));
// The downloads and the build space are estimates: Bun's package cache while node_modules installs is about the size of node_modules (about 1 GB measured), and the packages download compressed (about half).
engines.home = { installed_bytes: homeInstalled, download_bytes: Math.round(homeInstalled * 0.3), peak_temp_bytes: 1_200_000_000, basis: "estimate" };

const out = { measured_on: new Date().toISOString().slice(0, 10), machine: `${process.platform} ${process.arch}, ${dataDirectory}`, margin_percent: 20, headroom_warn_bytes: 5 * 1_073_741_824, uv_cache_over_environments: Number(ratio.toFixed(3)), engines, pins };
writeFileSync(join(import.meta.dir, "..", "src", "lib", "diskPlanMeasured.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`Wrote the disk table: ${Object.keys(pins).length} pins, ${Object.keys(engines).length} engines, Home ${(homeInstalled / 1e9).toFixed(2)} GB.`);
