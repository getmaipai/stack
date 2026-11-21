// ADMIN-10: scripts/release-stack.sh and scripts/install.sh, end to end with a
// fake build: a shell "binary" that answers the service commands and serves
// /healthz from a tiny Python server. Nothing touches launchd, systemd, the
// network or a real Stack: the base URL is a file:// folder and the prefix is a
// scratch directory.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const platform = process.platform === "darwin" ? "darwin" : "linux";
const arch = process.arch === "arm64" ? "arm64" : "x64";
const binaryName = `maipai-stack-${platform}-${arch}`;
const work = mkdtempSync(join(tmpdir(), "stack-install-test-"));
const port = String(18700 + (process.pid % 200));

const FAKE = `#!/usr/bin/env bash
# fake Stack: the service commands install.sh calls
dir="$(cd "$(dirname "$0")" && pwd -P)"
state="$STACK_DATA_DIR/fake-pid"
case "$1" in
  install-service|start)
    mkdir -p "$STACK_DATA_DIR/www"; echo '{"ok":true}' > "$STACK_DATA_DIR/www/healthz"; echo code-123 > "$STACK_DATA_DIR/admin-setup-code"
    if [ -f "$dir/BROKEN" ]; then exit 0; fi
    (cd "$STACK_DATA_DIR/www" && exec python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1) & echo $! > "$state"; [ "$1" = install-service ] && echo installed; true ;;
  stop) [ -f "$state" ] && kill "$(cat "$state")" 2>/dev/null; rm -f "$state"; true ;;
  status) echo "running" ;;
  uninstall-service) [ -f "$state" ] && kill "$(cat "$state")" 2>/dev/null; rm -f "$state"; echo removed ;;
esac
`;

function sh(script: string, args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync(["bash", script, ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", cwd: repo });
  return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() };
}

const build = join(work, "build");
const releases = join(work, "releases");
const served = join(work, "served");
const prefix = join(work, "prefix");
const env = { STACK_PREFIX: prefix, STACK_PORT: port, STACK_RELEASE_BASE_URL: `file://${served}`, STACK_BUN_BIN: "/usr/bin/true" };
const install = (...args: string[]) => sh(join(repo, "scripts/install.sh"), args, env);

function release(tag: string, marker: string) {
  writeFileSync(join(build, "marker"), marker);
  const result = sh(join(repo, "scripts/release-stack.sh"), [tag], { BUILD_DIR: build, RELEASE_DIR: releases });
  expect(result.code).toBe(0);
  const dir = join(served, tag);
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(releases)) if (name !== "install.sh") copyFileSync(join(releases, name), join(dir, name));
}

beforeAll(() => {
  for (const part of ["admin-ui", "migrations", "backend-src"]) mkdirSync(join(build, part), { recursive: true });
  writeFileSync(join(build, binaryName), FAKE);
  chmodSync(join(build, binaryName), 0o755);
  release("v1.0.0", "one");
  release("v1.1.0", "two");
});

afterAll(() => {
  install("uninstall");
  rmSync(work, { recursive: true, force: true });
});

const currentTag = () => readlinkSync(join(prefix, "current")).replace("releases/", "");

test("release-stack.sh writes a tarball and a SHA256SUMS line per tarball, and refuses a bad name", () => {
  const sums = readFileSync(join(releases, "SHA256SUMS"), "utf8").trim().split("\n");
  expect(sums.length).toBe(2);
  expect(sums[0]).toMatch(new RegExp(`^[0-9a-f]{64}  maipai-stack-v1\\.0\\.0-${platform}-${arch}\\.tar\\.gz$`));
  expect(sh(join(repo, "scripts/release-stack.sh"), ["latest"]).code).toBe(2);
});

test("install checks the download, places the build, starts the service and prints the admin URL and setup code location", () => {
  const result = install("install", "--tag", "v1.0.0");
  expect(result.out).toContain("Checksum verified");
  expect(result.out).toContain(`http://127.0.0.1:${port}/admin/`);
  expect(result.out).toContain(join(prefix, "data", "admin-setup-code"));
  expect(result.code).toBe(0);
  expect(currentTag()).toBe("v1.0.0");
  expect(existsSync(join(prefix, "current", "admin-ui"))).toBe(true);
  expect(install("install", "--tag", "v1.1.0").code).toBe(1);
}, 30_000);

test("a download that does not match its checksum installs nothing", () => {
  const bad = join(served, "v9.0.0");
  mkdirSync(bad, { recursive: true });
  copyFileSync(join(served, "v1.1.0", `maipai-stack-v1.1.0-${platform}-${arch}.tar.gz`), join(bad, `maipai-stack-v9.0.0-${platform}-${arch}.tar.gz`));
  writeFileSync(join(bad, "SHA256SUMS"), `${"0".repeat(64)}  maipai-stack-v9.0.0-${platform}-${arch}.tar.gz\n`);
  const result = install("update", "--tag", "v9.0.0");
  expect(result.code).toBe(1);
  expect(result.out).toContain("does not match its checksum");
  expect(currentTag()).toBe("v1.0.0");
  expect(existsSync(join(prefix, "releases", "v9.0.0"))).toBe(false);
});

test("update swaps the build, keeps the old one as previous, and rollback swaps back", () => {
  expect(install("update", "--tag", "v1.1.0").code).toBe(0);
  expect(currentTag()).toBe("v1.1.0");
  expect(readlinkSync(join(prefix, "previous"))).toBe("releases/v1.0.0");
  expect(readFileSync(join(prefix, "current", "marker"), "utf8")).toBe("two");
  expect(install("rollback").code).toBe(0);
  expect(currentTag()).toBe("v1.0.0");
  expect(readFileSync(join(prefix, "current", "marker"), "utf8")).toBe("one");
  expect(lstatSync(join(prefix, "data")).isDirectory()).toBe(true);
}, 60_000);

test("an update whose build never answers goes back to the old build by itself", () => {
  // v1.2.0 carries a marker file that makes the fake binary start without listening
  writeFileSync(join(build, "BROKEN"), "");
  release("v1.2.0", "broken");
  rmSync(join(build, "BROKEN"));
  const result = install("update", "--tag", "v1.2.0");
  expect(result.code).toBe(1);
  expect(result.out).toContain("v1.0.0 is running again");
  expect(currentTag()).toBe("v1.0.0");
}, 60_000);

test("uninstall removes the builds and keeps the data unless told otherwise", () => {
  expect(install("uninstall").code).toBe(0);
  expect(existsSync(join(prefix, "current"))).toBe(false);
  expect(existsSync(join(prefix, "releases"))).toBe(false);
  expect(existsSync(join(prefix, "data"))).toBe(true);
});
