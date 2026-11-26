// GLOBAL-LICENCE: an admin accepts once at /stack/v1/licences and every part's
// licence notice (current and future) counts as accepted, so install never
// answers licence_required after that. A stored terms version older than the
// constant asks again.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/app";
import { __setComponentDepsForTests, __setComponentUnitsForTests, __settleComponentInstallsForTests, type EnvDef, type UnitDef } from "@/lib/components";
import { __resetJobsForTests } from "@/lib/jobs";
import { clearModelsForTests, type CatalogModelLike } from "@/lib/modelStore";
import { dataDir } from "@/lib/paths";
import { hfRepoRoot } from "@/lib/store/layout";
import { GLOBAL_LICENCE_TERMS_VERSION, type LicenceNotice } from "@/lib/licenceAcceptance";

const sha = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");
const REPO = "example/tiny-global";
const REVISION = "r1";
function tinyPin(id: string, file: string, bytes: string): CatalogModelLike {
  return { id, role: "image", repo: REPO, license: "Apache-2.0", revision: REVISION, engine: "mflux", sizing: { profile: "p16" }, download: { url: `https://huggingface.co/${REPO}/resolve/${REVISION}/${file}`, sha256: sha(bytes), approx_bytes: bytes.length, hub_file: file } };
}
const BYTES: Record<string, string> = { "alpha.safetensors": "a".repeat(2048), "beta.safetensors": "b".repeat(512) };

let envReady = false;
let envDir = "";
const env: EnvDef = { name: "fake-env", approxBytes: 4096, root: () => envDir, ready: () => envReady && existsSync(join(envDir, "lib.bin")), build: async () => { envReady = true; mkdirSync(envDir, { recursive: true }); writeFileSync(join(envDir, "lib.bin"), "e".repeat(1000)); }, stop: () => {} };

const NOTICE_A: LicenceNotice = { id: "tiny-licence-a", name: "Tiny Licence A", url: "https://example.com/licence-a", summary: ["One plain-word point."] };
const NOTICE_B: LicenceNotice = { id: "tiny-licence-b", name: "Tiny Licence B", url: "https://example.com/licence-b", summary: ["Another plain-word point."] };

function unit(over: Partial<UnitDef> = {}): UnitDef {
  return { id: "tiny-alpha", label: "Pictures: Tiny", summary: "A test picture model.", group: "pictures", role: "image", pins: [tinyPin("tiny-alpha", "alpha.safetensors", BYTES["alpha.safetensors"]!)], envs: [env], usedBy: () => ["Pictures"], busy: () => null, ...over };
}
const fakeDownload = async (url: string, dest: string, opts: { onProgress?: (p: never) => void }) => {
  const file = url.split("/").at(-1)!;
  mkdirSync(join(dest, ".."), { recursive: true });
  writeFileSync(dest, BYTES[file]!);
  opts.onProgress?.({ completedBytes: BYTES[file]!.length, totalBytes: BYTES[file]!.length, itemId: file, itemCompletedBytes: BYTES[file]!.length } as never);
};

const licenceFile = join(dataDir, "licence-acceptances.json");
const postLicences = (body: unknown = {}) => app.request("/stack/v1/licences", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const install = (id: string) => app.request(`/stack/v1/components/${id}/install`, { method: "POST" });

beforeEach(() => {
  clearModelsForTests(); __resetJobsForTests(); forgetFiles();
  __setComponentDepsForTests({ download: fakeDownload as never });
});
afterEach(() => { __setComponentUnitsForTests(null); __setComponentDepsForTests(null); clearModelsForTests(); rmSync(licenceFile, { force: true }); });
function forgetFiles(): void {
  envReady = false;
  envDir = join(dataDir, "engines", "fake-env", "1");
  rmSync(hfRepoRoot(REPO), { recursive: true, force: true }); rmSync(envDir, { recursive: true, force: true });
  rmSync(licenceFile, { force: true });
}

test("one global acceptance covers a licensed part: refused before, installs after without accepted_licence", async () => {
  __setComponentUnitsForTests([unit({ licenceNotice: NOTICE_A })]);
  const refused = await install("tiny-alpha");
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ code: "licence_required" });
  const accepted = await postLicences({ by: "an admin" });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ terms_version: GLOBAL_LICENCE_TERMS_VERSION, accepted: true, by: "an admin" });
  const started = await install("tiny-alpha");
  expect(started.status).toBe(202);
  expect((await started.json() as { job: string | null }).job).not.toBeNull();
  await __settleComponentInstallsForTests();
});

test("a second, different licensed part also installs with no prompt", async () => {
  __setComponentUnitsForTests([
    unit({ licenceNotice: NOTICE_A }),
    unit({ id: "tiny-beta", pins: [tinyPin("tiny-beta", "beta.safetensors", BYTES["beta.safetensors"]!)], licenceNotice: NOTICE_B }),
  ]);
  expect((await install("tiny-beta")).status).toBe(409);
  expect((await postLicences()).status).toBe(200);
  const second = await install("tiny-beta");
  expect(second.status).toBe(202);
  await __settleComponentInstallsForTests();
});

test("a stored terms version older than the current one asks again: GET says accepted false and install is refused", async () => {
  __setComponentUnitsForTests([unit({ licenceNotice: NOTICE_A })]);
  expect((await postLicences()).status).toBe(200);
  // Write the record back with an older terms version, as an update would leave it.
  const stored = JSON.parse(readFileSync(licenceFile, "utf8")) as { __global__: Record<string, string | null> };
  stored.__global__ = { terms_version: "2020-01-01", accepted_at: stored.__global__.accepted_at ?? "", by: stored.__global__.by ?? null };
  writeFileSync(licenceFile, JSON.stringify(stored));
  const view = await (await app.request("/stack/v1/licences")).json() as { accepted: boolean; accepted_at: string | null; by: string | null };
  expect(view.accepted).toBe(false);
  expect(view.accepted_at).toBeNull();
  expect(view.by).toBeNull();
  expect((await install("tiny-alpha")).status).toBe(409);
});

test("GET lists every part's licence notice, de-duplicated by id", async () => {
  __setComponentUnitsForTests([
    unit({ licenceNotice: NOTICE_A }),
    unit({ id: "tiny-alpha-again", pins: [tinyPin("tiny-alpha-again", "alpha.safetensors", BYTES["alpha.safetensors"]!)], licenceNotice: NOTICE_A }),
    unit({ id: "tiny-beta", pins: [tinyPin("tiny-beta", "beta.safetensors", BYTES["beta.safetensors"]!)], licenceNotice: NOTICE_B }),
  ]);
  const view = await (await app.request("/stack/v1/licences")).json() as { licences: { id: string; name: string; url: string; summary: string[] }[] };
  expect(view.licences.map((notice) => notice.id)).toEqual([NOTICE_A.id, NOTICE_B.id]);
  expect(view.licences[0]).toMatchObject({ name: NOTICE_A.name, url: NOTICE_A.url, summary: NOTICE_A.summary });
});
