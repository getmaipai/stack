#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const publicRoot = join(siteRoot, "public");
const installPath = join(publicRoot, "install.sh");
const stub = `#!/bin/sh
set -eu
echo "The first release is not out yet; see the install guide" >&2
exit 1
`;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function download(url) {
  const response = await fetch(url, { headers: { "User-Agent": "maipai-stack-docs" } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function checksumForInstall(sums) {
  const line = sums.toString("utf8").split("\n").find((entry) => /(?:^|\s)install\.sh$/.test(entry));
  return line?.trim().split(/\s+/)[0] ?? null;
}

async function main() {
  mkdirSync(publicRoot, { recursive: true });
  const tag = process.env.MAIPAI_STACK_RELEASE_TAG;
  if (!tag) {
    writeFileSync(installPath, stub, { mode: 0o755 });
    console.log("No release tag supplied; wrote the pre-release install stub.");
    return;
  }

  const base = process.env.MAIPAI_STACK_RELEASE_BASE_URL ?? `https://github.com/getmaipai/stack/releases/download/v${tag}`;
  const [install, sums] = await Promise.all([download(`${base}/install.sh`), download(`${base}/SHA256SUMS`)]);
  const expected = checksumForInstall(sums);
  const actual = sha256(install);
  if (!expected) throw new Error("SHA256SUMS has no install.sh entry");
  if (actual !== expected) throw new Error(`install.sh checksum mismatch: expected ${expected}, got ${actual}`);
  writeFileSync(installPath, install, { mode: 0o755 });
  chmodSync(installPath, 0o755);
  console.log(`Pinned install.sh to release ${tag} (${actual}).`);
}

await main();
