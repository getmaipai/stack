// `maipai-stack speech-worker --role stt --port <n> --model <dir> --vad
// <file>`: the process the supervisor spawns for the speech roles, one
// per role. It loads the runtime and the role's model package, serves
// the wire on loopback, and exits when its stdin closes or it is
// signalled, so a daemon that dies never leaves a worker behind.
import { basename } from "node:path";
import { loadMoonshine, loadSilero, RUNTIME_NAME, runtimeVersion } from "@/speech/sherpa";
import { startSpeechServer } from "@/speech/server";

export interface WorkerArgs { role: "stt"; port: number; model: string; vad: string; threads: number; }

export function parseWorkerArgs(argv: string[]): WorkerArgs {
  const value = (flag: string): string | undefined => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : undefined; };
  const role = value("--role");
  if (role !== "stt") throw new Error(`speech-worker serves --role stt (got ${role ?? "nothing"}).`);
  const port = Number(value("--port"));
  const model = value("--model");
  const vad = value("--vad");
  if (!Number.isInteger(port) || port <= 0) throw new Error("speech-worker needs --port <n>.");
  if (!model) throw new Error("speech-worker needs --model <dir>.");
  if (!vad) throw new Error("speech-worker needs --vad <file>.");
  const threads = Number(value("--threads") ?? 2);
  return { role, port, model, vad, threads: Number.isInteger(threads) && threads > 0 ? threads : 2 };
}

/** What `/props` reports: the runtime and its exact version as the
 * build, the package directory as the model path, so the identity
 * headers say `local sherpa-onnx-node-1.13.8` and the package name. */
export function workerBuild(): string { return `${RUNTIME_NAME}-${runtimeVersion()}`; }

export async function runSpeechWorker(argv: string[]): Promise<void> {
  const args = parseWorkerArgs(argv);
  const transcriber = loadMoonshine(args.model, args.threads);
  const server = startSpeechServer({ port: args.port, build: workerBuild(), modelPath: args.model, transcriber, detector: () => loadSilero(args.vad) });
  console.log(`speech-worker ${args.role} listening on http://127.0.0.1:${server.port} with ${basename(args.model)}`);
  const stop = () => { server.stop(true); process.exit(0); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  // The supervisor holds stdin open; its end is the daemon gone.
  process.stdin.on("end", stop);
  process.stdin.on("close", stop);
  process.stdin.resume();
}
