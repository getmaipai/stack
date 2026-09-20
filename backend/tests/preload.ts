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
import { GOVERNOR_MEMORY_DEFAULT } from "./governorMemoryDefault";

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

// 2026-09-19: the governor reads the real host's free memory once at
// module load (canAdmit's totalMemoryBytes/freeMemoryBytes), so any test
// that never calls __setGovernorTuningForTestsOnly silently depended on
// this machine's actual free memory. With the host low on memory, every
// such test failed to admit a model. Setting a generous, fixed reading
// here (before any test file gets its own turn) makes every file's
// default state independent of the host; a test that wants a specific
// pressure state still sets its own value with the same function.
//
// The imports are dynamic (awaited) rather than top-level: a static
// import here is hoisted ahead of the STACK_DATA_DIR setup above, which
// would open the real stack.db from the un-redirected data dir. @/app is
// loaded first, and on its own line, because the backend has more than
// one real circular import touching the governor (memory -> darwin ->
// repairs -> supervisor -> governor -> memory, and separately settings/
// stackKeys -> governor -> ... -> settings/stackKeys): entering directly
// through @/lib/governor or @/lib/memory resolves one cycle only to hit
// the other mid-load. @/app is what every test file already imports
// first in practice, so it is the one entry point already proven to
// resolve every cycle in the graph safely; only once it has fully
// loaded is it safe to reach into @/lib/governor and @/lib/memory
// directly.
await import("@/app");
const { __setGovernorTuningForTestsOnly } = await import("@/lib/governor");
const { __setMemoryReaderForTests } = await import("@/lib/memory");
const { scriptedMemoryReader } = await import("@/lib/memory/scripted");
__setGovernorTuningForTestsOnly({ totalMemoryBytes: GOVERNOR_MEMORY_DEFAULT.totalBytes, freeMemoryBytes: GOVERNOR_MEMORY_DEFAULT.freeBytes });

// __resetGovernorForTests() (governor.test.ts, runState.test.ts) re-reads
// memory as part of its own reset, which would otherwise undo the line
// above for every test in every file that runs after the first one that
// calls it. It reads through getMemoryReader(), the same reader
// memoryReader.test.ts exercises directly, so scripting the reader
// itself (rather than trying to re-apply governor's own tuning after
// every test — attempted first, but a global afterEach registered here
// does not reliably run for every later file's tests) keeps every
// caller's default off the host, including a reset. A test that
// specifically wants the real reader (memoryReader.test.ts, the
// supervisor.test.ts kernel-footprint test) opts out with
// __setMemoryReaderForTests(null) and restores this same reading
// afterward.
__setMemoryReaderForTests(scriptedMemoryReader([GOVERNOR_MEMORY_DEFAULT]));
