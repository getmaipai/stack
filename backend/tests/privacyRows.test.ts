// Every host this backend can talk to has a row on the privacy
// declaration (integrations.md, "The privacy rows"). A new fetch target
// without a row fails here, in the same commit that added it.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/app";
import { PRIVACY_ROWS } from "@/lib/privacy";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => { const path = join(dir, entry); return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : []; });
}

test("every outbound host literal in backend/src has a privacy row", () => {
  const declared = new Set(PRIVACY_ROWS.flatMap((row) => row.hosts));
  const hosts = new Set<string>();
  for (const file of sourceFiles(join(import.meta.dir, "..", "src"))) {
    for (const match of readFileSync(file, "utf8").matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) hosts.add(match[1]!.toLowerCase());
  }
  // Not fetch targets: the plist DOCTYPE's DTD reference in service/launchd.ts.
  hosts.delete("www.apple.com");
  for (const host of hosts) expect(declared, `no privacy row names ${host}`).toContain(host);
});

test("the rows are served as data for Home's privacy page", async () => {
  const response = await app.request("/stack/v1/privacy");
  const body = await response.json() as { rows: Array<{ what: string; when: string; carries: string; receiver: string; setting: string | null }> };
  expect(body.rows.length).toBe(PRIVACY_ROWS.length);
  for (const row of body.rows) for (const field of ["what", "when", "carries", "receiver"] as const) expect(row[field].length).toBeGreaterThan(10);
});
