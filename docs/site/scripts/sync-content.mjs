#!/usr/bin/env node
// Copies docs/user/ and docs/dev.md + docs/dev/*.md into this Starlight
// site's content collection before every dev/build (astro.config.mjs's
// docsLoader() can only read src/content/docs/, no external base path -
// so the source of truth stays docs/user and docs/dev, and this is a
// pure sync step, never hand-edited). docs/user/*.md already carries the
// title/description frontmatter Starlight requires (docs/STYLE.md's own
// user-tier convention); docs/dev.md and docs/dev/*.md are plain session
// logs with none, so this injects a real one derived from each file's
// own first heading rather than duplicating content by hand.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const docsRoot = join(siteRoot, "..");
const contentRoot = join(siteRoot, "src", "content", "docs");

function hasFrontmatter(text) {
  return text.startsWith("---\n");
}

function firstHeadingTitle(text, fallback) {
  const match = /^#\s+(.+)$/m.exec(text);
  return match ? match[1].trim() : fallback;
}

function firstParagraph(text) {
  const body = text.replace(/^#\s+.+$/m, "").trim();
  const match = /^([^\n]+)/.exec(body);
  if (!match) return "";
  return match[1].replace(/[`*_]/g, "").slice(0, 140).trim();
}

function yamlEscape(s) {
  return s.replace(/"/g, '\\"');
}

function syncVerbatim(srcDir, destDir) {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith(".md")) continue;
    const text = readFileSync(join(srcDir, name), "utf8");
    writeFileSync(join(destDir, name), text);
  }
}

function syncWithInjectedFrontmatter(files, destDir) {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  for (const { path, name } of files) {
    const text = readFileSync(path, "utf8");
    if (hasFrontmatter(text)) {
      writeFileSync(join(destDir, name), text);
      continue;
    }
    const title = firstHeadingTitle(text, name.replace(/\.md$/, ""));
    const description = firstParagraph(text) || `MaiPai Stack developer notes: ${title}`;
    const withFrontmatter = `---\ntitle: "${yamlEscape(title)}"\ndescription: "${yamlEscape(description)}"\n---\n\n${text}`;
    writeFileSync(join(destDir, name), withFrontmatter);
  }
}

// docs/user/*.md -> the "Guide" section, verbatim (already has frontmatter).
syncVerbatim(join(docsRoot, "user"), join(contentRoot, "guide"));

// docs/user/*.md's own screenshots reference `../assets/screens/*.png`,
// relative to docs/user/ - copied to the same relative depth here
// (content/docs/assets/, one level up from content/docs/guide/) so
// those paths resolve unchanged, rather than rewriting every image
// reference in every synced file.
rmSync(join(contentRoot, "assets", "screens"), { recursive: true, force: true });
if (existsSync(join(docsRoot, "assets", "screens"))) {
  mkdirSync(join(contentRoot, "assets"), { recursive: true });
  cpSync(join(docsRoot, "assets", "screens"), join(contentRoot, "assets", "screens"), { recursive: true });
}

// docs/dev.md + docs/dev/*.md -> the "Developer" section, frontmatter
// injected. docs/dev/ does not exist yet, so skip it if missing.
const devFiles = [{ path: join(docsRoot, "dev.md"), name: "index.md" }];
if (existsSync(join(docsRoot, "dev"))) {
  for (const name of readdirSync(join(docsRoot, "dev"))) {
    if (name.endsWith(".md")) devFiles.push({ path: join(docsRoot, "dev", name), name });
  }
}
syncWithInjectedFrontmatter(devFiles, join(contentRoot, "dev"));

console.log(`Synced ${readdirSync(join(contentRoot, "guide")).length} user-guide page(s) and ${devFiles.length} developer page(s).`);
