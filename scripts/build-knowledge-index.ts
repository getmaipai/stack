import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBinaryPath } from "../node_modules/pagefind/lib/resolveBinary.js";

const root = join(import.meta.dir, "..");
const docsRoot = join(root, "docs/user");
const output = join(root, "frontend", "dist", "knowledge");
const bundle = join(output, "pagefind");
const tempSite = mkdtempSync(join(tmpdir(), "maipai-knowledge-"));
rmSync(bundle, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const records = readdirSync(docsRoot).filter((file) => file.endsWith(".md")).map((file) => {
  const markdown = readFileSync(join(docsRoot, file), "utf8");
  const title = markdown.match(/^#\s+(.+)$/m)?.[1] ?? file.replace(/\.md$/, "");
  const excerpt = markdown.replace(/^---[\s\S]*?---\s*/, "").replace(/[#*`]/g, "").trim().slice(0, 240);
  const url = `/knowledge/${file.replace(/\.md$/, ".html")}`;
  writeFileSync(join(tempSite, file.replace(/\.md$/, ".html")), `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1><p>${excerpt}</p></main></body></html>\n`);
  return { title, url, excerpt };
});
writeFileSync(join(output, "index.json"), JSON.stringify({ records }, null, 2) + "\n");
const result = Bun.spawnSync([resolveBinaryPath(["pagefind_extended", "pagefind"]), "--site", tempSite, "--output-path", bundle, "--output-subdir", "."], { stdout: "inherit", stderr: "inherit", cwd: root });
if (result.exitCode !== 0) throw new Error(`Pagefind exited with ${result.exitCode}`);
if (!existsSync(join(bundle, "pagefind-entry.json"))) throw new Error("Pagefind did not write pagefind/pagefind-entry.json");
rmSync(tempSite, { recursive: true, force: true });
