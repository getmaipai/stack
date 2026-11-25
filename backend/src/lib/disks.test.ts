import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDisk, diskIdOfPath, DriveNotConnectedError, isManagedModelPath, listDisks, modelsRootFor, removeDisk } from "@/lib/disks";
import { upsertModel, removeModel } from "@/lib/modelStore";

describe("model drives", () => {
  test("validates roots, tracks models, and refuses in-use removal", () => {
    const root = mkdtempSync(join(tmpdir(), "stack-disk-"));
    try {
      const drive = join(root, "external"); mkdirSync(drive);
      const added = addDisk({ label: "Travel Drive", rootPath: drive, removable: true });
      expect(added.id).toBe("travel-drive"); expect(modelsRootFor(added.id)).toBe(join(drive, "maipai-models"));
      expect(isManagedModelPath(join(drive, "maipai-models", "model", "weights.bin"))).toBe(true);
      expect(diskIdOfPath(join(drive, "maipai-models", "model"))).toBe(added.id);
      expect(() => addDisk({ label: "Nested", rootPath: join(drive, "maipai-models"), removable: false })).toThrow();
      upsertModel({ id: "test-drive-model", roles: ["chat"], source: "catalog", provenance: {}, revision: "r1", modelPath: join(drive, "maipai-models", "x.bin"), diskId: added.id });
      expect(() => removeDisk(added.id)).toThrow("1 model is on");
      removeModel("test-drive-model"); removeDisk(added.id);
      expect(listDisks().then((rows) => rows.some((row) => row.id === added.id))).resolves.toBe(false);
      expect(() => modelsRootFor(added.id)).toThrow(DriveNotConnectedError);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("does not treat a neighboring path as managed", () => {
    const root = mkdtempSync(join(tmpdir(), "stack-path-"));
    try { expect(isManagedModelPath(join(root, "models-elsewhere", "file"))).toBe(false); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
});
