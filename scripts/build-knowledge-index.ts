import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBinaryPath } from "../node_modules/pagefind/lib/resolveBinary.js";

const root = join(import.meta.dir, "..");
const docsRoot = join(root, "docs/user");
const output = join(root, "frontend", "dist", "knowledge");
const assetsOutput = join(root, "frontend", "dist", "assets", "screens");
const bundle = join(output, "pagefind");
const tempSite = mkdtempSync(join(tmpdir(), "maipai-knowledge-"));
rmSync(bundle, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const anchor = (value: string) => value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
function inline(value: string): string { return escape(value).replace(/!\[([^\]]*)\]\(([^\s)]+)[^)]*\)/g, (_all, alt, src) => `<img alt="${alt}" src="${src.replace("../assets/screens/", "/assets/screens/")}">`).replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>').replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>"); }
function render(markdown: string): string {
  const lines = markdown.replace(/^---[\s\S]*?---\s*/, "").trim().split("\n"); const result: string[] = []; let paragraph: string[] = []; let list: string[] = []; let code: string[] = []; let inCode = false;
  const flushParagraph = () => { if (paragraph.length) result.push(`<p>${inline(paragraph.join(" "))}</p>`); paragraph = []; };
  const flushList = () => { if (list.length) result.push(`<ol>${list.map((entry) => `<li>${inline(entry)}</li>`).join("")}</ol>`); list = []; };
  for (const line of lines) {
    if (line.startsWith("```")) { if (inCode) { result.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`); code = []; } else { flushParagraph(); flushList(); } inCode = !inCode; continue; }
    if (inCode) { code.push(line); continue; }
    const heading = line.match(/^(#{1,4})\s+(.+)$/); const item = line.match(/^\d+\.\s+(.+)$/);
    if (heading) { const hashes = heading[1]; const text = heading[2]; if (!hashes || !text) continue; flushParagraph(); flushList(); result.push(`<h${hashes.length} id="${anchor(text)}">${inline(text)}</h${hashes.length}>`); }
    else if (item?.[1]) { flushParagraph(); list.push(item[1]); }
    else if (!line.trim()) { flushParagraph(); flushList(); } else paragraph.push(line.trim());
  }
  flushParagraph(); flushList(); return result.join("\n");
}
const records = readdirSync(docsRoot).filter((file) => file.endsWith(".md")).map((file) => {
  const markdown = readFileSync(join(docsRoot, file), "utf8");
  const title = markdown.match(/^#\s+(.+)$/m)?.[1] ?? file.replace(/\.md$/, "");
  const excerpt = markdown.replace(/^---[\s\S]*?---\s*/, "").replace(/[#*`]/g, "").trim().slice(0, 240);
  const slug = file.replace(/\.md$/, "");
  const url = `/knowledge/${slug}.html`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main>${render(markdown)}</main></body></html>\n`;
  writeFileSync(join(tempSite, `${slug}.html`), html);
  writeFileSync(join(output, `${slug}.html`), html);
  for (const image of markdown.matchAll(/\.\.\/assets\/screens\/([^\s)]+)/g)) { const source = join(root, "docs/assets/screens", image[1]!); if (existsSync(source)) { mkdirSync(assetsOutput, { recursive: true }); copyFileSync(source, join(assetsOutput, image[1]!)); } }
  return { title, slug, url, excerpt };
});
writeFileSync(join(output, "index.json"), JSON.stringify({ records }, null, 2) + "\n");
const result = Bun.spawnSync([resolveBinaryPath(["pagefind_extended", "pagefind"]), "--site", tempSite, "--output-path", bundle, "--output-subdir", "."], { stdout: "inherit", stderr: "inherit", cwd: root });
if (result.exitCode !== 0) throw new Error(`Pagefind exited with ${result.exitCode}`);
if (!existsSync(join(bundle, "pagefind-entry.json"))) throw new Error("Pagefind did not write pagefind/pagefind-entry.json");
rmSync(tempSite, { recursive: true, force: true });
