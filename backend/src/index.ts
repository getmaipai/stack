// The entry point: one command per process. `speech-worker` loads only
// the worker (its native runtime and nothing of the daemon, so it never
// opens the daemon's database); everything else is the daemon's.
async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  if (command === "speech-worker") { const { runSpeechWorker } = await import("@/speech/worker"); return runSpeechWorker(process.argv.slice(3)); }
  const { runDaemonCommand } = await import("@/daemon");
  return runDaemonCommand(command);
}

// Only the entry point runs a command; a test that imports this file's
// neighbours must not start a server.
if (import.meta.main) void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
