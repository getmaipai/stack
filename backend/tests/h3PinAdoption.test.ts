// H3 pin adoption, on the pinned folder SHAPE: the same 39 relative paths the real pin lists (qwen/8-bit, transformers/8-bit, upstream/FL2VA under models/minimax_h3), each with
// tiny stand-in bytes and a table built from them. Nothing here is a model file and no engine starts. What it proves: a complete folder is adopted, one corrupted file of the
// SAME size is not (the hash decides, not the size), a missing file and an empty or absent folder are told apart, the status never writes into the folder, and the cheap look
// (`hashes: false`) never claims a folder is verified.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { H3_PINNED_FILES, h3PinStatus } from "@/video/h3Pin";

const roots: string[] = [];
const fresh = () => { const path = mkdtempSync(join(tmpdir(), "h3-adopt-")); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); delete process.env.MAIPAI_H3_VIDEO_HOME; });

const bytesOf = (local: string) => new TextEncoder().encode(`stand-in for ${local}`);
const table = H3_PINNED_FILES.map((file) => ({ ...file, bytes: bytesOf(file.local).length, sha256: createHash("sha256").update(bytesOf(file.local)).digest("hex") }));
function build(home: string): void {
  for (const file of table) { const path = join(home, "models/minimax_h3", file.local); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytesOf(file.local)); }
}
const snapshot = (dir: string): string[] => readdirSync(dir, { withFileTypes: true, recursive: true }).map((entry) => { const path = join(entry.parentPath, entry.name); const stat = statSync(path); return `${path}:${entry.isDirectory() ? "d" : stat.size}:${stat.mtimeMs}`; }).sort();

describe("the pinned folder shape (the three trees the real pin lists)", () => {
  test("the table has the real layout: qwen, transformers and upstream trees only, no lora and no unpublished stream file", () => {
    expect(new Set(H3_PINNED_FILES.map((file) => file.local.split("/").slice(0, 2).join("/")))).toEqual(new Set(["qwen/8-bit", "transformers/8-bit", "upstream/FL2VA"]));
  });
  test("a complete folder from the environment variable is adopted; the same folder under the install path is pinned", async () => {
    const home = fresh(); build(home);
    process.env.MAIPAI_H3_VIDEO_HOME = home;
    const adopted = await h3PinStatus(home, table);
    expect(adopted).toMatchObject({ state: "adopted_existing", mismatched: [], absent: [] });
    expect(adopted.matched).toHaveLength(39);
    delete process.env.MAIPAI_H3_VIDEO_HOME;
    expect((await h3PinStatus(home, table)).state).toBe("pinned");
  });
  test("one file with the right SIZE and wrong bytes is not adopted: the hash catches it, and only that file is named", async () => {
    const home = fresh(); build(home);
    process.env.MAIPAI_H3_VIDEO_HOME = home;
    const victim = table[17]!;
    writeFileSync(join(home, "models/minimax_h3", victim.local), new TextEncoder().encode(`STAND-IN FOR ${victim.local}`)); // same length, different bytes
    expect(statSync(join(home, "models/minimax_h3", victim.local)).size).toBe(victim.bytes);
    const status = await h3PinStatus(home, table);
    expect(status.state).toBe("existing_unverified");
    expect(status.mismatched).toEqual([victim.local]);
    expect(status.matched).toHaveLength(38);
  });
  test("one file with the wrong size is named without being read; one missing file is told apart from a corrupted one", async () => {
    const home = fresh(); build(home);
    process.env.MAIPAI_H3_VIDEO_HOME = home;
    writeFileSync(join(home, "models/minimax_h3", table[3]!.local), "short");
    rmSync(join(home, "models/minimax_h3", table[30]!.local));
    const status = await h3PinStatus(home, table);
    expect(status.state).toBe("existing_unverified");
    expect(status.mismatched).toEqual([table[3]!.local]);
    expect(status.absent).toEqual([table[30]!.local]);
  });
  test("an empty folder and a folder that does not exist are told apart; a missing path from the variable reads as an existing install that cannot be verified (documented behavior)", async () => {
    const empty = fresh();
    const emptyStatus = await h3PinStatus(empty, table);
    expect(emptyStatus).toMatchObject({ state: "existing_unverified", matched: [], mismatched: [] });
    expect(emptyStatus.absent).toHaveLength(39);
    const gone = join(fresh(), "not-there");
    expect((await h3PinStatus(gone, table)).state).toBe("missing");
    process.env.MAIPAI_H3_VIDEO_HOME = gone;
    expect((await h3PinStatus(gone, table)).state).toBe("existing_unverified");
  });
});

describe("what the status may and may not do to the folder", () => {
  test("neither the cheap look nor the full check writes into the folder: its listing, sizes and times are the same afterwards", async () => {
    const home = fresh(); build(home);
    process.env.MAIPAI_H3_VIDEO_HOME = home;
    const before = snapshot(home);
    await h3PinStatus(home, table, { hashes: false });
    await h3PinStatus(home, table);
    expect(snapshot(home)).toEqual(before);
  });
  test("the cheap look never claims a folder is verified: with nothing hashed it is existing_unverified and matches nothing, even for a complete and correct folder", async () => {
    const home = fresh(); build(home);
    process.env.MAIPAI_H3_VIDEO_HOME = home;
    const cheap = await h3PinStatus(home, table, { hashes: false });
    expect(cheap.state).toBe("existing_unverified");
    expect(cheap.matched).toEqual([]);
  });
  test("a folder whose file changed after it was hashed is looked at again: the hash cache is keyed by size and time", async () => {
    const home = fresh(); build(home);
    process.env.MAIPAI_H3_VIDEO_HOME = home;
    expect((await h3PinStatus(home, table)).state).toBe("adopted_existing");
    const victim = table[5]!;
    const path = join(home, "models/minimax_h3", victim.local);
    writeFileSync(path, new TextEncoder().encode(`STAND-IN FOR ${victim.local}`));
    const later = new Date(Date.now() + 5_000); // a changed file has a new time even when a write lands in the same millisecond
    (await import("node:fs")).utimesSync(path, later, later);
    expect((await h3PinStatus(home, table)).mismatched).toEqual([victim.local]);
  });
});
