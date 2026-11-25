import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDisk, removeDisk } from "@/lib/disks";
import { modelsDir } from "@/lib/paths";
import { upsertModel, getModel, removeModel } from "@/lib/modelStore";
import { __setDiskReaderForTests } from "@/lib/diskState";
import { runModelMove, resumeMoveJobs } from "@/lib/moveModels";

describe("model moves", () => {
  test("moves a file and recovers a post-switch interruption", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "stack-move-")), drive = join(scratch, "drive"); mkdirSync(drive);
    const disk = addDisk({ label: "Move test", rootPath: drive, removable: true });
    const oldPath = join(modelsDir, "move-test.bin"); mkdirSync(modelsDir, { recursive: true }); writeFileSync(oldPath, "model bytes");
    upsertModel({ id: "move-test", roles: ["chat"], source: "catalog", provenance: {}, revision: "r1", modelPath: oldPath, sha256: null });
    __setDiskReaderForTests(() => ({ free: 20_000_000_000, total: 30_000_000_000 }));
    try {
      await expect(runModelMove("move-test", disk.id, { hooks: { afterSwitch: () => { throw new Error("crash"); } } })).rejects.toThrow("crash");
      await resumeMoveJobs();
      const moved = getModel("move-test")!; expect(moved.diskId).toBe(disk.id); expect(existsSync(moved.modelPath!)).toBe(true);
      expect(existsSync(oldPath)).toBe(false); expect(readFileSync(moved.modelPath!, "utf8")).toBe("model bytes");
    } finally { removeModel("move-test"); removeDisk(disk.id); __setDiskReaderForTests(null); rmSync(scratch, { recursive: true, force: true }); rmSync(oldPath, { force: true }); }
  });

  const setup = (id: string, files: Record<string, string>, sha: string | null = null) => {
    const scratch = mkdtempSync(join(tmpdir(), "stack-move-")), drive = join(scratch, "drive"); mkdirSync(drive);
    const disk = addDisk({ label: `Drive ${id}`, rootPath: drive, removable: true });
    const oldPath = join(modelsDir, id); mkdirSync(oldPath, { recursive: true });
    for (const [name, text] of Object.entries(files)) { mkdirSync(join(oldPath, name, ".."), { recursive: true }); writeFileSync(join(oldPath, name), text); }
    upsertModel({ id, roles: ["chat"], source: "catalog", provenance: {}, revision: "r1", modelPath: oldPath, sha256: sha });
    __setDiskReaderForTests(() => ({ free: 20_000_000_000, total: 30_000_000_000 }));
    const done = () => { removeModel(id); removeDisk(disk.id); __setDiskReaderForTests(null); rmSync(scratch, { recursive: true, force: true }); rmSync(oldPath, { recursive: true, force: true }); };
    return { disk, oldPath, done };
  };

  test("moves a folder with nested files", async () => {
    const t = setup("move-folder", { "a.txt": "A", "sub/b.txt": "BB" });
    try {
      await runModelMove("move-folder", t.disk.id);
      const moved = getModel("move-folder")!; expect(moved.diskId).toBe(t.disk.id);
      expect(readFileSync(join(moved.modelPath!, "sub/b.txt"), "utf8")).toBe("BB"); expect(existsSync(t.oldPath)).toBe(false);
    } finally { t.done(); }
  });

  test("a copy that does not verify keeps the original and marks the job failed", async () => {
    const t = setup("move-corrupt", { "a.txt": "AAAA" });
    try {
      await expect(runModelMove("move-corrupt", t.disk.id, { hooks: { afterCopy: () => { const moving = join(getModel("move-corrupt")!.modelPath!.replace(modelsDir, join(t.disk.root_path, "maipai-models")) + ".moving", "a.txt"); writeFileSync(moving, "AAAB"); } } })).rejects.toThrow("did not verify");
      const kept = getModel("move-corrupt")!; expect(kept.diskId).toBeNull(); expect(readFileSync(join(t.oldPath, "a.txt"), "utf8")).toBe("AAAA");
    } finally { t.done(); }
  });

  test("a crash after copy or after verify leaves the old copy live and a retry works", async () => {
    const t = setup("move-crash", { "a.txt": "A" });
    try {
      await expect(runModelMove("move-crash", t.disk.id, { hooks: { afterCopy: () => { throw new Error("boom1"); } } })).rejects.toThrow("boom1");
      expect(getModel("move-crash")!.diskId).toBeNull(); expect(existsSync(t.oldPath)).toBe(true);
      await expect(runModelMove("move-crash", t.disk.id, { hooks: { afterVerify: () => { throw new Error("boom2"); } } })).rejects.toThrow("boom2");
      expect(getModel("move-crash")!.diskId).toBeNull(); expect(existsSync(t.oldPath)).toBe(true);
      await resumeMoveJobs(); await runModelMove("move-crash", t.disk.id);
      expect(getModel("move-crash")!.diskId).toBe(t.disk.id); expect(existsSync(t.oldPath)).toBe(false);
    } finally { t.done(); }
  });

  test("refuses with a plain reason: not enough space, same drive, disconnected drive", async () => {
    const t = setup("move-refuse", { "a.txt": "A" });
    try {
      __setDiskReaderForTests(() => ({ free: 1_000_000, total: 30_000_000_000 }));
      await expect(runModelMove("move-refuse", t.disk.id)).rejects.toThrow("not enough free space");
      __setDiskReaderForTests(() => ({ free: 20_000_000_000, total: 30_000_000_000 }));
      await expect(runModelMove("move-refuse", "main")).rejects.toThrow("already on that drive");
      rmSync(t.disk.root_path, { recursive: true, force: true });
      await expect(runModelMove("move-refuse", t.disk.id)).rejects.toThrow("not connected");
      expect(existsSync(t.oldPath)).toBe(true);
    } finally { mkdirSync(t.disk.root_path, { recursive: true }); t.done(); }
  });

  test("only one move runs at a time", async () => {
    const t = setup("move-one", { "a.txt": "A" });
    try {
      let second: unknown;
      await runModelMove("move-one", t.disk.id, { hooks: { afterCopy: async () => { second = await runModelMove("move-one", t.disk.id).catch((e) => e); } } });
      expect(String(second)).toContain("Another move is running");
    } finally { t.done(); }
  });
});
