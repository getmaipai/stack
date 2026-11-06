import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export type FontRole = "display" | "smallCaps" | "names";
const families: Record<FontRole, string[]> = {
  display: ["Didot", "Bodoni 72", "Baskerville"],
  smallCaps: ["Gill Sans", "Futura", "Helvetica Neue"],
  names: ["Baskerville", "Hoefler Text", "Didot"],
};
const roots = process.platform === "darwin" ? ["/System/Library/Fonts/Supplemental", "/System/Library/Fonts", "/Library/Fonts"] : ["/usr/share/fonts"];
function fontFiles(): Array<{ path: string; name: string }> {
  const result: Array<{ path: string; name: string }> = [];
  const visit = (dir: string) => { try { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) visit(path); else if (/\.(ttf|ttc|otf)$/i.test(entry.name)) result.push({ path, name: entry.name.toLowerCase() }); } } catch { /* inaccessible font directory */ } };
  roots.forEach(visit); return result;
}
export function resolveFonts(): { fontsdir: string; display: string; smallCaps: string; names: string; caption: string } | null {
  const files = fontFiles();
  let installed = "";
  try { installed = execFileSync("fc-list", ["--format", "%{family}\\n"], { encoding: "utf8", timeout: 3000 }).toLowerCase(); } catch { /* filename checks still work on minimal systems */ }
  const pick = (role: FontRole): string | null => {
    for (const family of families[role]) {
      const token = family.toLowerCase().replace(/[^a-z0-9]/g, "");
      const found = files.find((file) => file.name.replace(/[^a-z0-9]/g, "").includes(token) || installed.includes(family.toLowerCase()));
      if (found) return family;
    }
    return null;
  };
  const display = pick("display"), smallCaps = pick("smallCaps"), names = pick("names");
  if (!display || !smallCaps || !names) return null;
  const fontsdir = roots.find((root) => existsSync(root)) ?? roots[0]!;
  return { fontsdir, display, smallCaps, names, caption: smallCaps };
}
export function assText(text: string): string {
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").replace(/{/g, "\\{").replace(/}/g, "\\}").replace(/\r\n|\r|\n/g, "\\N").replace(/'/g, "\u2019");
}
export function fitTitleFontSize(text: string, width: number, height: number): number {
  const min = height / 22, max = height / 10, budget = width * 0.78;
  const lines = text.split(/\s+/), longest = Math.max(...lines.map((line) => [...line].length));
  const size = Math.min(max, budget / Math.max(1, longest * 0.62));
  return Math.max(min, size);
}
export function wrapTitle(text: string, width: number, height: number): string {
  const words = text.split(/\s+/); if (words.length < 2) return text;
  const minSize = height / 22, budget = width * .78, fullChars = [...text].length;
  if (Math.min(height / 10, budget / Math.max(1, fullChars * .75)) > minSize) return text;
  let best = "", bestWidth = Infinity;
  for (let i = 1; i < words.length; i++) { const left = words.slice(0, i).join(" "), right = words.slice(i).join(" "), score = Math.max([...left].length, [...right].length); if (score < bestWidth) { best = `${left}\\N${right}`; bestWidth = score; } }
  return best;
}
export const assColor = (colour: string): string => {
  const hex = colour === "black" ? "000000" : colour === "white" ? "FFFFFF" : colour.slice(1);
  return `&H${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}&`;
};
export function writeAss(path: string, contents: string): void { writeFileSync(path, contents, "utf8"); }
export const ASS_HEADER = (width: number, height: number, styles: string) => `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n${styles}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
