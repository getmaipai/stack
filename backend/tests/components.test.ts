// COMPONENTS-01: the component list, install and uninstall, on small units
// with pins whose bytes the suite makes (no network, no model, no engine
// environment build). The real list is checked for shape and for the
// Z-Image-Turbo entry the owner asked for.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/app";
import { diskPlanForTier, diskTotalsFor } from "@/lib/diskPlan";
import { ComponentError, __setComponentDepsForTests, __setComponentUnitsForTests, __settleComponentInstallsForTests, componentDefs, forgetSizes, listComponents, startComponentInstall, uninstallComponent, type EnvDef, type UnitDef } from "@/lib/components";
import { noteComponentUse, __forgetUseForTests } from "@/lib/componentUse";
import { __resetHealthForTests, list as listHealth } from "@/lib/health";
import { runFix } from "@/routes/health";
import { __resetJobsForTests, createJob, getJob } from "@/lib/jobs";
import { clearModelsForTests, getModel, upsertModel, registerCatalogModel, type CatalogModelLike } from "@/lib/modelStore";
import type { HardwareInfo } from "@/lib/hardware";
import { dataDir } from "@/lib/paths";
import { hfSnapshotsRoot, hfBlobsRoot, hfRepoRoot } from "@/lib/store/layout";
import { writeHfFile } from "@/lib/store/hfCache";
import { imageLoras } from "@/images/loras";
import { resetSupervisorForTests, setSupervisorFactoryForTests } from "@/lib/supervisor";
import { STACK_IMAGE_ZIMAGE_MODELS } from "@/lib/modelCatalog";

const GB = 1_073_741_824;
const hw = (over: Partial<HardwareInfo> = {}): HardwareInfo => ({ platform: "darwin", arch: "arm64", totalRamGb: 128, cpuCount: 16, isAppleSilicon: true, unifiedMemoryGb: 128, cudaDevices: [], freeDiskBytes: 1500 * GB, osVersion: "test", ...over });

const sha = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");
const REPO = "example/tiny-picture";
const REVISION = "r1";
function tinyPin(id: string, file: string, bytes: string, over: Partial<CatalogModelLike> = {}): CatalogModelLike {
  return { id, role: "image", repo: REPO, license: "Apache-2.0", revision: REVISION, engine: "mflux", sizing: { profile: "p16" }, download: { url: `https://huggingface.co/${REPO}/resolve/${REVISION}/${file}`, sha256: sha(bytes), approx_bytes: bytes.length, hub_file: file }, ...over };
}
const BYTES: Record<string, string> = { "weights.safetensors": "w".repeat(2048), "vae.safetensors": "v".repeat(512), "other.safetensors": "o".repeat(300) };

let envBuilt = 0;
let envReady = false;
let envDir = "";
const env: EnvDef = { name: "fake-env", approxBytes: 4096, root: () => envDir, ready: () => envReady && existsSync(join(envDir, "lib.bin")), build: async () => { envBuilt += 1; envReady = true; mkdirSync(envDir, { recursive: true }); writeFileSync(join(envDir, "lib.bin"), "e".repeat(1000)); }, stop: () => {} };
let busy: string | null = null;

function unit(over: Partial<UnitDef> = {}): UnitDef {
  return {
    id: "tiny-picture", label: "Pictures: Tiny", summary: "A test picture model.", group: "pictures", role: "image",
    pins: [tinyPin("tiny-picture", "weights.safetensors", BYTES["weights.safetensors"]!), tinyPin("tiny-picture-vae", "vae.safetensors", BYTES["vae.safetensors"]!, { component: "tiny:vae" })],
    envs: [env], usedBy: () => ["Pictures"], busy: () => busy, ...over,
  };
}
const fakeDownload = async (url: string, dest: string, opts: { onProgress?: (p: never) => void }) => {
  const file = url.split("/").at(-1)!;
  mkdirSync(join(dest, ".."), { recursive: true });
  writeFileSync(dest, BYTES[file]!);
  opts.onProgress?.({ completedBytes: BYTES[file]!.length, totalBytes: BYTES[file]!.length, itemId: file, itemCompletedBytes: BYTES[file]!.length } as never);
};

beforeEach(() => {
  clearModelsForTests(); __resetJobsForTests(); __resetHealthForTests(); __forgetUseForTests(); forgetSizes();
  envBuilt = 0; envReady = false; busy = null;
  envDir = join(dataDir, "engines", "fake-env", "1");
  rmSync(hfRepoRoot(REPO), { recursive: true, force: true }); rmSync(envDir, { recursive: true, force: true });
  __setComponentUnitsForTests([unit()]);
  __setComponentDepsForTests({ download: fakeDownload as never });
});
afterEach(() => { __setComponentUnitsForTests(null); __setComponentDepsForTests(null); clearModelsForTests(); setSupervisorFactoryForTests(null); resetSupervisorForTests(); });

test("the real list names Z-Image-Turbo as an optional picture model on a 128 GB computer, with its full size", async () => {
  __setComponentUnitsForTests(null);
  const list = await listComponents(hw());
  expect(list.tier).toBe("p128");
  const z = list.components.find((c) => c.id === "z-image-turbo")!;
  expect(z).toMatchObject({ label: "Pictures: Z-Image-Turbo", group: "pictures", requirement: "optional", state: "notInstalled", can_install: true, can_uninstall: false, size_bytes: null });
  const pins = STACK_IMAGE_ZIMAGE_MODELS.reduce((sum, pin) => sum + pin.download!.approx_bytes, 0);
  expect(z.full_bytes).toBeGreaterThanOrEqual(pins);
  // The wizard's disk plan has the same row, optional (unchecked by default), and the fit uses its sums.
  const plan = diskPlanForTier("p128")!;
  const row = plan.rows.find((candidate) => candidate.id === "pictures-zimage")!;
  expect(z.plan_need).toBe("optional");
  expect(plan.default_selected).not.toContain("pictures-zimage");
  expect(z.required_free_bytes).toBe(diskTotalsFor(plan, [row.id]).required_free_bytes);
  expect(z.full_bytes).toBe(diskTotalsFor(plan, [row.id]).download_bytes);
  expect(pins).toBeGreaterThan(32e9);
  expect(pins).toBeLessThan(35e9);
  expect(list.components.every((c) => c.id && c.label && !c.label.includes("—"))).toBe(true);
});

test("a smaller computer cannot install Z-Image-Turbo and is told why; the install route refuses it", async () => {
  __setComponentUnitsForTests(null);
  const list = await listComponents(hw({ unifiedMemoryGb: 32, totalRamGb: 32 }));
  const z = list.components.find((c) => c.id === "z-image-turbo")!;
  expect(z.requirement).toBe("unsupported");
  expect(z.can_install).toBe(false);
  expect(z.install_block).toBe("This needs a computer with more memory than this one.");
  await expect(startComponentInstall("z-image-turbo", hw({ unifiedMemoryGb: 32, totalRamGb: 32 }))).rejects.toMatchObject({ code: "not_available", status: 409 });
});

test("a download that does not fit the data volume is disabled with the room needed and the room left", async () => {
  __setComponentUnitsForTests(null);
  const list = await listComponents(hw({ freeDiskBytes: 20 * GB }));
  const z = list.components.find((c) => c.id === "z-image-turbo")!;
  expect(z.can_install).toBe(false);
  expect(z.install_block).toMatch(/^Not enough room: it needs about \d+ GB and this computer has \d+ GB free\. Free some space first\.$/);
  await expect(startComponentInstall("z-image-turbo", hw({ freeDiskBytes: 20 * GB }))).rejects.toMatchObject({ code: "not_enough_space" });
});

test("install is one job: the files, then the environment; the list follows; a second install is a no-op", async () => {
  const before = (await listComponents(hw())).components.find((c) => c.id === "tiny-picture")!;
  expect(before).toMatchObject({ state: "notInstalled", download_bytes: 2048 + 512 + 4096, requirement: "optional" });
  const started = await startComponentInstall("tiny-picture", hw());
  expect(started.joined).toBe(false);
  const again = await startComponentInstall("tiny-picture", hw());
  expect(again).toMatchObject({ job: started.job, joined: true });
  expect((await listComponents(hw())).components.find((c) => c.id === "tiny-picture")).toMatchObject({ state: "installing", job: started.job, can_install: false });
  await __settleComponentInstallsForTests();
  const job = getJob(started.job!)!;
  expect(job).toMatchObject({ kind: "component.install", state: "done", role: "image", input: { component: "tiny-picture", model: "tiny-picture", label: "Pictures: Tiny" } });
  expect(job.items?.map((item) => item.id)).toEqual(["tiny-picture", "tiny-picture-vae", "env:fake-env"]);
  expect(envBuilt).toBe(1);
  const after = (await listComponents(hw())).components.find((c) => c.id === "tiny-picture")!;
  expect(after).toMatchObject({ state: "installed", download_bytes: 0, can_install: false, install_block: "It is already installed.", can_uninstall: true });
  expect(after.size_bytes).toBeGreaterThan(1000);
  expect(await startComponentInstall("tiny-picture", hw())).toMatchObject({ job: null, already: true });
});

test("a failed install raises one Repairs item with Try again, state failed, and Try again installs", async () => {
  __setComponentDepsForTests({ download: (async () => { throw new Error("The connection dropped."); }) as never });
  const started = await startComponentInstall("tiny-picture", hw());
  await __settleComponentInstallsForTests();
  expect(getJob(started.job!)!).toMatchObject({ state: "failed", reason: "The connection dropped." });
  const item = listHealth().find((entry) => entry.code === "component-install-failed.tiny-picture")!;
  expect(item).toMatchObject({ title: "Pictures: Tiny could not be installed", cause: "The connection dropped.", fix: { label: "Try again", action: "retry_download" } });
  expect((await listComponents(hw())).components.find((c) => c.id === "tiny-picture")).toMatchObject({ state: "failed", failure: "The connection dropped.", can_install: true });
  __setComponentDepsForTests({ download: fakeDownload as never });
  const fixed = await runFix("component-install-failed.tiny-picture");
  expect(fixed).toMatchObject({ ok: true });
  await __settleComponentInstallsForTests();
  expect(listHealth().some((entry) => entry.code.startsWith("component-install-failed"))).toBe(false);
  expect((await listComponents(hw())).components.find((c) => c.id === "tiny-picture")!.state).toBe("installed");
});

test("uninstall removes the records, the hub files and the environment, reports the bytes freed, and is idempotent", async () => {
  await startComponentInstall("tiny-picture", hw());
  await __settleComponentInstallsForTests();
  const blobs = hfBlobsRoot(REPO);
  expect(readdirSync(blobs).length).toBe(2);
  const result = await uninstallComponent("tiny-picture", hw());
  expect(result).toMatchObject({ component: "tiny-picture", removed: true });
  expect(result.freed_bytes).toBeGreaterThanOrEqual(2048 + 512);
  expect(getModel("tiny-picture")).toBeNull();
  expect(getModel("tiny-picture-vae")).toBeNull();
  expect(existsSync(blobs)).toBe(false);
  expect(existsSync(hfSnapshotsRoot(REPO))).toBe(false);
  expect(existsSync(envDir)).toBe(false);
  expect(await uninstallComponent("tiny-picture", hw())).toEqual({ component: "tiny-picture", freed_bytes: 0, removed: false });
  expect((await listComponents(hw())).components.find((c) => c.id === "tiny-picture")).toMatchObject({ state: "notInstalled", size_bytes: null, uninstall_block: "It is not installed." });
});

test("a shared environment stays until the last component that runs in it leaves", async () => {
  const sibling = unit({ id: "tiny-sibling", label: "Pictures: Sibling", pins: [tinyPin("tiny-sibling", "other.safetensors", BYTES["other.safetensors"]!)] });
  __setComponentUnitsForTests([unit(), sibling]);
  await startComponentInstall("tiny-picture", hw());
  await __settleComponentInstallsForTests();
  await startComponentInstall("tiny-sibling", hw());
  await __settleComponentInstallsForTests();
  expect(readdirSync(hfBlobsRoot(REPO)).length).toBe(3);
  const first = await uninstallComponent("tiny-picture", hw());
  expect(first.removed).toBe(true);
  expect(existsSync(envDir)).toBe(true);
  expect(readdirSync(hfBlobsRoot(REPO)).length).toBe(1);
  await uninstallComponent("tiny-sibling", hw());
  expect(existsSync(envDir)).toBe(false);
  expect(existsSync(hfBlobsRoot(REPO))).toBe(false);
});

test("uninstall is refused while a request or job uses it, with the reason; the files stay", async () => {
  await startComponentInstall("tiny-picture", hw());
  await __settleComponentInstallsForTests();
  busy = "A picture is being made right now.";
  await expect(uninstallComponent("tiny-picture", hw())).rejects.toMatchObject({ code: "in_use", message: "A picture is being made right now. Try again when it finishes.", status: 409 });
  const row = (await listComponents(hw())).components.find((c) => c.id === "tiny-picture")!;
  expect(row).toMatchObject({ can_uninstall: false, uninstall_block: "A picture is being made right now. Try again when it finishes." });
  expect(getModel("tiny-picture")).not.toBeNull();
  busy = null;
  expect((await uninstallComponent("tiny-picture", hw())).removed).toBe(true);
});

test("a component that is still installing cannot be removed", async () => {
  const gate = Promise.withResolvers<void>();
  __setComponentDepsForTests({ download: (async (...args: [string, string, never]) => { await gate.promise; return fakeDownload(...args); }) as never });
  await startComponentInstall("tiny-picture", hw());
  await expect(uninstallComponent("tiny-picture", hw())).rejects.toMatchObject({ code: "in_use" });
  gate.resolve();
  await __settleComponentInstallsForTests();
});

function chatUnit(id: string, serves = "chat"): UnitDef {
  return { id, label: `Chat model: ${id}`, summary: "", group: "chat", role: "chat", serves, pins: [{ id, role: "chat", repo: "example/chat", license: "Apache-2.0", revision: "r1", engine: "llama-server", sizing: { profile: "p16" }, download: { url: `https://huggingface.co/example/chat/resolve/r1/${id}.gguf`, sha256: sha(id), approx_bytes: id.length } }], envs: [], usedBy: () => [], busy: () => null };
}
function installChatRecord(id: string): void {
  const dir = join(dataDir, "models", id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.gguf`);
  writeFileSync(path, id);
  upsertModel({ ...registerCatalogModel(chatUnit(id).pins[0]!), verifiedAt: "2026-10-17T00:00:00.000Z", modelPath: path, sizeBytes: id.length });
}

test("the chat model chat is using, and the only chat model, cannot be removed; another one can", async () => {
  const a = chatUnit("chat-a"); const b = chatUnit("chat-b");
  __setComponentUnitsForTests([a, b]);
  installChatRecord("chat-a");
  await expect(uninstallComponent("chat-a", hw())).rejects.toMatchObject({ code: "chat_model_in_use" });
  installChatRecord("chat-b");
  // chat-a sorts first, so it is the selected one; chat-b is spare.
  await expect(uninstallComponent("chat-a", hw())).rejects.toMatchObject({ code: "chat_model_in_use", message: "Chat is using this model. Pick another chat model first, then remove this one." });
  expect((await uninstallComponent("chat-b", hw())).removed).toBe(true);
  await expect(uninstallComponent("chat-a", hw())).rejects.toBeInstanceOf(ComponentError);
});

test("an unknown id is a 404; the routes answer with the list, a job and the freed bytes", async () => {
  expect((await app.request("/stack/v1/components/nope/install", { method: "POST" })).status).toBe(404);
  expect((await app.request("/stack/v1/components/nope", { method: "DELETE" })).status).toBe(404);
  const list = await (await app.request("/stack/v1/components")).json() as { components: Array<{ id: string; state: string }>; free_disk_bytes: number | null };
  expect(list.components.find((c) => c.id === "tiny-picture")?.state).toBe("notInstalled");
  const install = await app.request("/stack/v1/components/tiny-picture/install", { method: "POST" });
  expect(install.status).toBe(202);
  await __settleComponentInstallsForTests();
  const again = await app.request("/stack/v1/components/tiny-picture/install", { method: "POST" });
  expect(again.status).toBe(200);
  expect(await again.json()).toEqual({ job: null, component: "tiny-picture", already_installed: true });
  const removed = await app.request("/stack/v1/components/tiny-picture", { method: "DELETE" });
  expect(removed.status).toBe(200);
  expect(await removed.json()).toMatchObject({ component: "tiny-picture", removed: true });
  busy = "A picture is being made right now.";
  await startComponentInstall("tiny-picture", hw()); await __settleComponentInstallsForTests();
  const refused = await app.request("/stack/v1/components/tiny-picture", { method: "DELETE" });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ code: "in_use" });
});

test("last use is recorded once a minute and shows on the component", async () => {
  await startComponentInstall("tiny-picture", hw());
  await __settleComponentInstallsForTests();
  expect((await listComponents(hw())).components.find((c) => c.id === "tiny-picture")!.last_used_at).toBeNull();
  noteComponentUse("tiny-picture-vae");
  const stamp = (await listComponents(hw())).components.find((c) => c.id === "tiny-picture")!.last_used_at!;
  expect(Date.parse(stamp)).toBeGreaterThan(Date.now() - 5000);
});

test("a household LoRA is a removable item that is never installable here", async () => {
  __setComponentUnitsForTests([]);
  const original = imageLoras.list;
  const removed: string[] = [];
  (imageLoras as unknown as { list: unknown }).list = () => [{ id: "lora-abc", name: "Watercolor", bytes: 1234, base_model: "z-image-turbo" }];
  const originalRemove = imageLoras.remove;
  (imageLoras as unknown as { remove: unknown }).remove = async (id: string) => { removed.push(id); return true; };
  try {
    const row = (await listComponents(hw())).components.find((c) => c.id === "lora.picture.lora-abc")!;
    expect(row).toMatchObject({ label: "Style: Watercolor", kind: "lora", group: "loras", state: "installed", size_bytes: 1234, can_install: false, can_uninstall: true, depends_on: ["z-image-turbo"] });
    expect(await uninstallComponent("lora.picture.lora-abc", hw())).toEqual({ component: "lora.picture.lora-abc", freed_bytes: 1234, removed: true });
    expect(removed).toEqual(["lora-abc"]);
  } finally { (imageLoras as unknown as { list: unknown }).list = original; (imageLoras as unknown as { remove: unknown }).remove = originalRemove; }
});

test("the real component ids are unique and every required one is a pin of the install plan", async () => {
  __setComponentUnitsForTests(null);
  const ids = componentDefs().map((def) => def.id);
  expect(new Set(ids).size).toBe(ids.length);
  createJob({ kind: "noop" });
  const list = await listComponents(hw());
  for (const row of list.components.filter((c) => c.requirement === "required")) expect(row.requirement_reason).toBe("Home installs this on a computer of this size.");
});

// ---- VIDEO-LTX-01: the Detailed video model's licence, size and gate ----

test("the real list offers Detailed video on a 128 GB computer only: optional, its plain size, and the licence it needs accepted", async () => {
  __setComponentUnitsForTests(null);
  const list = await listComponents(hw());
  const detailed = list.components.find((c) => c.id === "ltx-2-3-distilled-mlx")!;
  expect(detailed).toMatchObject({ label: "Video: Detailed (LTX-2.3)", group: "video", requirement: "optional", state: "notInstalled", can_install: true, plan_need: "recommended" });
  expect(detailed.full_bytes).toBeGreaterThan(70e9);
  expect(detailed.licence).toMatchObject({ id: "ltx-2.x-community-2026-08-11", accepted_at: null });
  expect(detailed.licence!.summary.join(" ")).toContain("$10 million");
  expect(detailed.licence!.summary.join(" ")).toContain("children");
  const quick = list.components.find((c) => c.id === "fastwan2-2-ti2v-5b-mlx-bf16")!;
  expect(quick.licence).toBeNull();
  expect(quick.label).toContain("Quick");
  for (const tier of [{ unifiedMemoryGb: 64, totalRamGb: 64 }, { unifiedMemoryGb: 32, totalRamGb: 32 }]) {
    const small = (await listComponents(hw(tier))).components.find((c) => c.id === "ltx-2-3-distilled-mlx")!;
    expect(small.requirement).toBe("unsupported");
    expect(small.can_install).toBe(false);
  }
});

test("Detailed video does not install until the licence is accepted, then installs and asks no more", async () => {
  const { LTX_LICENCE_NOTICE } = await import("@/lib/modelCatalog");
  const { licenceAcceptance } = await import("@/lib/licenceAcceptance");
  rmSync(join(dataDir, "licence-acceptances.json"), { force: true });
  __setComponentUnitsForTests([unit({ id: "tiny-detailed", licenceNotice: LTX_LICENCE_NOTICE })]);
  const view = (await listComponents(hw())).components.find((c) => c.id === "tiny-detailed")!;
  expect(view.licence).toMatchObject({ id: LTX_LICENCE_NOTICE.id, accepted_at: null });
  await expect(startComponentInstall("tiny-detailed", hw())).rejects.toMatchObject({ code: "licence_required", status: 409 });
  await expect(startComponentInstall("tiny-detailed", hw(), { licence: "some-other-licence" })).rejects.toMatchObject({ code: "licence_required" });
  expect(licenceAcceptance(LTX_LICENCE_NOTICE.id)).toBeNull();
  expect(getJob("none")).toBeNull();
  const started = await startComponentInstall("tiny-detailed", hw(), { licence: LTX_LICENCE_NOTICE.id, by: "an admin" });
  expect(started.job).not.toBeNull();
  await __settleComponentInstallsForTests();
  expect(licenceAcceptance(LTX_LICENCE_NOTICE.id)).toMatchObject({ licence: LTX_LICENCE_NOTICE.id, by: "an admin" });
  expect((await listComponents(hw())).components.find((c) => c.id === "tiny-detailed")!.licence!.accepted_at).not.toBeNull();
  // After a removal, the next install does not ask again.
  await uninstallComponent("tiny-detailed");
  expect((await startComponentInstall("tiny-detailed", hw())).job).not.toBeNull();
  await __settleComponentInstallsForTests();
  rmSync(join(dataDir, "licence-acceptances.json"), { force: true });
});

test("the install route takes the accepted licence in its body and refuses without it", async () => {
  const { LTX_LICENCE_NOTICE } = await import("@/lib/modelCatalog");
  rmSync(join(dataDir, "licence-acceptances.json"), { force: true });
  __setComponentUnitsForTests([unit({ id: "tiny-detailed", licenceNotice: LTX_LICENCE_NOTICE })]);
  const refused = await app.request("/stack/v1/components/tiny-detailed/install", { method: "POST" });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ code: "licence_required" });
  const accepted = await app.request("/stack/v1/components/tiny-detailed/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accepted_licence: LTX_LICENCE_NOTICE.id, accepted_by: "an admin" }) });
  expect(accepted.status).toBe(202);
  await __settleComponentInstallsForTests();
  rmSync(join(dataDir, "licence-acceptances.json"), { force: true });
});

test("the coding model is a removable component on p128 and p64 (not required), and unsupported on p32 (CODE-STACK-01 S1)", async () => {
  __setComponentUnitsForTests(null);
  for (const gb of [128, 64]) {
    const list = await listComponents(hw({ unifiedMemoryGb: gb, totalRamGb: gb }));
    const coding = list.components.find((c) => c.id === "qwen3.8-27b-ud-q4-k-m")!;
    expect(coding).toBeDefined();
    expect(coding.requirement).toBe("optional");
    expect(coding.plan_need).toBe("recommended");
    expect(coding.full_bytes).toBe(16_464_440_224);
    expect(coding.install_block).toBeNull();
    // The chat models are still required; the coding model is the only coding row.
    expect(list.components.find((c) => c.id === "muse-glimmer-30b-q4-k-xl")!.requirement).toBe("required");
  }
  const small = await listComponents(hw({ unifiedMemoryGb: 32, totalRamGb: 32 }));
  expect(small.components.find((c) => c.id === "qwen3.8-27b-ud-q4-k-m")!.requirement).toBe("unsupported");
});
