// 2026-09-17 21:40 wipe: a gate run from the main checkout emptied the
// operator's real data/stack.db models table and removed installed
// manifests because STACK_DATA_DIR was unset and paths.ts resolved the
// checkout's own data/. This preload pins the suite to a scratch data
// directory of its own and refuses to run against anything else.
//
// Issue #7 (2026-09-20): the scratch directories used to be made under
// the OS temp dir and never removed, because Bun's test runner fires
// neither `exit` nor `beforeExit` for handlers a preload registers
// (measured: 3,084 directories on one machine). So the scratch now
// lives inside the repo's git-ignored `backend/data-test/`, one
// directory per run named by the process id, and every run starts by
// sweeping the directories of runs whose process is gone. A run leaves
// at most its own directory, and the next run takes it away; the OS
// temp dir is untouched. A caller may still hand in its own
// STACK_DATA_DIR, under the OS temp dir or under data-test/, and that
// one is the caller's to remove.
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { GOVERNOR_MEMORY_DEFAULT } from "./governorMemoryDefault";

const tmpRoot = realpathSync(tmpdir());
const scratchRoot = resolve(import.meta.dir, "..", "data-test");

// The keystore's file backend: a test run never touches a login keychain.
process.env.MAIPAI_KEYSTORE_BACKEND ??= "file";

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: string }).code === "EPERM"; }
}

/** Removes the scratch of every run whose process is gone, and of any
 * run older than a day whatever its pid says (a pid can belong to an
 * unrelated process after a reboot), so the folder holds live runs only. */
function sweepStaleRuns(): void {
  if (!existsSync(scratchRoot)) return;
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  for (const entry of readdirSync(scratchRoot)) {
    const match = /^run-(\d+)$/.exec(entry);
    if (!match) continue;
    const path = join(scratchRoot, entry);
    const old = statSync(path).mtimeMs < dayAgo;
    if (!old && processAlive(Number(match[1]))) continue;
    rmSync(path, { recursive: true, force: true });
  }
}

if (!process.env.STACK_DATA_DIR) {
  sweepStaleRuns();
  const own = join(scratchRoot, `run-${process.pid}`);
  rmSync(own, { recursive: true, force: true });
  mkdirSync(own, { recursive: true });
  process.env.STACK_DATA_DIR = own;
} else {
  const given = realpathSync(process.env.STACK_DATA_DIR);
  const scratch = existsSync(scratchRoot) ? realpathSync(scratchRoot) : scratchRoot;
  const within = (dir: string, root: string) => dir === root || dir.startsWith(root + sep);
  if (!within(given, tmpRoot) && !within(given, scratch)) {
    console.error(
      "refusing to run the backend test suite against a real data directory; STACK_DATA_DIR must be under the OS temp directory or backend/data-test/",
    );
    process.exit(1);
  }
}

if (!process.env.STACK_SCAN_ROOTS) {
  // The detection scan's roots live in the run's own scratch too.
  const roots = ["huggingface", "ollama", "mlx-serve", "omlx", "lm-studio"]
    .map((source) => { const root = join(process.env.STACK_DATA_DIR!, "scan", source); mkdirSync(root, { recursive: true }); return `${source}:${root}`; })
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
