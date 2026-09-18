// 2026-09-17 21:40 wipe: a gate run from the main checkout emptied the
// operator's real data/stack.db models table and removed installed
// manifests because STACK_DATA_DIR was unset and paths.ts resolved the
// checkout's own data/. This preload pins the suite to a fresh temp dir
// and refuses to run against anything that is not under the OS temp
// directory.
import { realpathSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = realpathSync(tmpdir());

if (!process.env.STACK_DATA_DIR) {
  process.env.STACK_DATA_DIR = mkdtempSync(join(tmpdir(), "maipai-stack-test-"));
} else if (!realpathSync(process.env.STACK_DATA_DIR).startsWith(tmpRoot)) {
  console.error(
    "refusing to run the backend test suite against a real data directory; STACK_DATA_DIR must be under the OS temp directory",
  );
  process.exit(1);
}

if (!process.env.STACK_SCAN_ROOTS) {
  const roots = ["huggingface", "ollama", "mlx-serve", "omlx", "lm-studio"]
    .map((source) => `${source}=${mkdtempSync(join(tmpdir(), `maipai-scan-${source}-`))}`)
    .join(",");
  process.env.STACK_SCAN_ROOTS = roots;
}
