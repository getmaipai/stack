// VISION-03g: an upgrade runs no install plan, so a part an installed
// model declares (Muse's picture projector) is pulled when the Stack
// starts, with a job for the install strip and a Repairs item when it
// cannot be fetched.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { list as listHealth, __resetHealthForTests } from "@/lib/health";
import { __resetGovernorForTests } from "@/lib/governor";
import { MISSING_PART_CODE, missingDeclaredParts, pullMissingDeclaredParts } from "@/lib/installJobs";
import { clearModelsForTests, getModel, registerCatalogModel, upsertModel, type CatalogModelLike } from "@/lib/modelStore";
import { listJobs } from "@/lib/jobs";
import { resetSupervisorForTests } from "@/lib/supervisor";
import { dataDir } from "@/lib/paths";

const BYTES = "projector-bytes";
const SHA = createHash("sha256").update(BYTES).digest("hex");
const projector: CatalogModelLike = { id: "t-proj", role: "chat", component: "projector", license: "Apache-2.0", revision: "r1", engine: "llama-server", download: { url: "https://example.com/r/resolve/r1/t-proj.gguf", sha256: SHA, approx_bytes: BYTES.length } };
const owner: CatalogModelLike = { id: "t-owner", role: "chat", license: "Apache-2.0", revision: "r1", engine: "llama-server", download: { url: "https://example.com/r/resolve/r1/t-owner.gguf", sha256: "a".repeat(64), approx_bytes: 4 }, imageInput: { projector: "t-proj" } };
const pins = [owner, projector];
const scratch = join(dataDir, "declared-parts-test");

function installOwner() {
  mkdirSync(scratch, { recursive: true });
  const file = join(scratch, "owner.gguf");
  writeFileSync(file, "weights");
  return upsertModel({ ...registerCatalogModel(owner), verifiedAt: "2026-10-17T00:00:00.000Z", modelPath: file });
}

beforeEach(() => { clearModelsForTests(); __resetHealthForTests(); __resetGovernorForTests(); });
afterEach(() => { resetSupervisorForTests(); clearModelsForTests(); rmSync(scratch, { recursive: true, force: true }); });

test("an installed model whose projector is not on disk lists it; a model not installed lists nothing", () => {
  expect(missingDeclaredParts(pins)).toEqual([]);
  installOwner();
  expect(missingDeclaredParts(pins).map((pin) => pin.id)).toEqual(["t-proj"]);
});

test("the missing projector is pulled as an install job and verified, then nothing is missing", async () => {
  installOwner();
  const pulled = await pullMissingDeclaredParts(pins, async (_url, dest) => { mkdirSync(join(dest, ".."), { recursive: true }); writeFileSync(dest, BYTES); });
  expect(pulled).toEqual(["t-proj"]);
  expect(getModel("t-proj")?.engineRequirements.component).toBe("projector");
  expect(missingDeclaredParts(pins)).toEqual([]);
  expect(listJobs().some((job) => job.kind === "model.install" && job.state === "done")).toBe(true);
  expect(listHealth().some((item) => item.code === MISSING_PART_CODE("t-proj"))).toBe(false);
});

test("a download that fails raises a Repairs item with a Try again fix, and a later success clears it", async () => {
  installOwner();
  await pullMissingDeclaredParts(pins, async () => { throw new Error("The network is unreachable."); });
  const item = listHealth().find((entry) => entry.code === MISSING_PART_CODE("t-proj"));
  expect(item?.fix?.action).toBe("retry_download");
  expect(item?.text).toContain("text only");
  await pullMissingDeclaredParts(pins, async (_url, dest) => { mkdirSync(join(dest, ".."), { recursive: true }); writeFileSync(dest, BYTES); });
  expect(listHealth().some((entry) => entry.code === MISSING_PART_CODE("t-proj"))).toBe(false);
});
