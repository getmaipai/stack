import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "maipai-stack-installer-"));
const home = join(root, "home"); const shimDir = join(root, "bin"); const launchLog = join(root, "launchctl.log");
const installer = join(import.meta.dir, "../../installer/install.sh");
let badChecksum = false;
let version = 1;
let server: Bun.Server<undefined>;

function binary(versionNumber: number): Buffer {
  return Buffer.from(`#!/bin/sh\ncase "${versionNumber}" in\n  *) case "$1" in install-service|uninstall-service|open) launchctl "$1" ;; esac ;;\nesac\n`, "utf8");
}
function checksum(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

beforeAll(() => {
  mkdirSync(home, { recursive: true }); mkdirSync(shimDir, { recursive: true });
  const launchctl = join(shimDir, "launchctl"); writeFileSync(launchctl, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$LAUNCHCTL_LOG\"\n"); chmodSync(launchctl, 0o755);
  server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/healthz") return Response.json({ ok: true });
    const bytes = binary(version); const digest = badChecksum ? "bad" : checksum(bytes);
    if (path.endsWith("maipai-stack-darwin-arm64")) return new Response(bytes);
    if (path.endsWith("SHA256SUMS")) return new Response(`${digest}  maipai-stack-darwin-arm64\n`);
    return new Response("not found", { status: 404 });
  }});
});

afterAll(() => { server.stop(true); rmSync(root, { recursive: true, force: true }); });

async function run(homeDirectory: string): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["sh", installer], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: homeDirectory, PATH: `${shimDir}:${process.env.PATH ?? ""}`, LAUNCHCTL_LOG: launchLog, MAIPAI_STACK_RELEASE_BASE_URL: `http://127.0.0.1:${server.port}/releases`, MAIPAI_STACK_HEALTH_URL: `http://127.0.0.1:${server.port}`, MAIPAI_STACK_SERVICE_LABEL: "com.maipai.stack.test" } });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { status: await child.exited, stdout, stderr };
}

test("installs, verifies, replaces, and uninstalls without deleting data", async () => {
  const first = await run(home); expect(first.status).toBe(0); const target = join(home, ".maipai/stack/bin/maipai-stack");
  expect(existsSync(target)).toBe(true); expect(readFileSync(target).toString()).toBe(binary(1).toString());
  const dataFile = join(home, ".maipai/stack/data/keep.txt"); writeFileSync(dataFile, "keep");
  version = 2; const second = await run(home); expect(second.status).toBe(0); expect(readFileSync(target).toString()).toBe(binary(2).toString());
  badChecksum = true; const removed = await run(join(root, "bad-home")); expect(removed.status).not.toBe(0); badChecksum = false;
  const uninstallChild = Bun.spawn(["sh", installer, "--uninstall"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: home, PATH: `${shimDir}:${process.env.PATH ?? ""}`, LAUNCHCTL_LOG: launchLog } });
  await Promise.all([new Response(uninstallChild.stdout).text(), new Response(uninstallChild.stderr).text()]);
  const uninstalled = { status: await uninstallChild.exited };
  expect(uninstalled.status).toBe(0); expect(existsSync(target)).toBe(false); expect(readFileSync(dataFile, "utf8")).toBe("keep");
  expect(readFileSync(launchLog, "utf8")).toContain("install-service"); expect(readFileSync(launchLog, "utf8")).toContain("uninstall-service");
});
