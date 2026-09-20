// `maipai-stack serve` runs the daemon on loopback; the other commands
// operate the service unit Home's installer created. Exit codes mean
// what they say: 0 on a clean stop, 1 on a fatal error, so the service
// manager's restart policy is the outer watchdog.
import { app } from "@/app";
import { logger } from "@/lib/log";
import { installLaunchdService, launchdStatus, startLaunchdService, stopLaunchdService, uninstallLaunchdService } from "@/service/launchd";
import { applyPendingSettings, settingValues } from "@/settings";
import { stopAllRoles, unloadIdleRoles } from "@/lib/supervisor";
import { execFileSync } from "node:child_process";

export function serveOptions(): { port: number; hostname: "127.0.0.1"; fetch: (request: Request) => Response | Promise<Response>; idleTimeout: number } {
  const port = Number(process.env.PORT ?? settingValues()["stack.runtime.port"] ?? 8770);
  return { port, hostname: "127.0.0.1", fetch: app.fetch, idleTimeout: 255 };
}

function onBattery(): boolean {
  if (process.platform !== "darwin") return false;
  try { return /Now drawing from ['"]Battery Power/.test(execFileSync("pmset", ["-g", "batt"], { encoding: "utf8", timeout: 1_000 })); } catch { return false; }
}

async function serve(): Promise<void> {
  logger.installConsoleMirror();
  applyPendingSettings();
  const options = serveOptions();
  const server = Bun.serve(options);
  const idle = setInterval(() => {
    const values = settingValues();
    void unloadIdleRoles({ onBattery: onBattery(), idleMinutes: Number(values["stack.runtime.idle_unload_minutes"] ?? 30), batteryIdleMinutes: Number(values["stack.runtime.idle_unload_on_battery_minutes"] ?? 10) }).catch(() => {});
  }, 60_000);
  (idle as unknown as { unref?: () => void }).unref?.();
  let stopping = false;
  const stop = async (exitCode: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(idle);
    await stopAllRoles("The Stack is stopping.");
    server.stop(true);
    process.exitCode = exitCode;
  };
  logger.installFatalErrorHandlers(() => stop(1));
  process.once("SIGTERM", () => { void stop(0); });
  process.once("SIGINT", () => { void stop(0); });
  console.log(`MaiPai Stack listening on http://127.0.0.1:${options.port} (liveness /healthz, explorer /api/docs)`);
  await new Promise<void>((resolve) => {
    const check = setInterval(() => { if (stopping) { clearInterval(check); resolve(); } }, 25);
    (check as unknown as { unref?: () => void }).unref?.();
  });
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  if (command === "serve") return serve();
  if (command === "install-service") { console.log(`Installed ${installLaunchdService(process.env.STACK_SERVICE_PROGRAM ?? process.execPath)}`); return; }
  if (command === "uninstall-service") {
    uninstallLaunchdService();
    if (process.argv.includes("--remove-data")) {
      const { rmSync } = await import("node:fs"); const { resolve } = await import("node:path");
      const data = process.env.STACK_DATA_DIR ? resolve(process.env.STACK_DATA_DIR) : "";
      if (data) rmSync(data, { recursive: true, force: true });
      console.log("Service and data removed.");
    } else console.log("Service removed. Data was kept.");
    return;
  }
  if (command === "start") { startLaunchdService(); console.log("Service started."); return; }
  if (command === "stop") { stopLaunchdService(); console.log("Service stopped."); return; }
  if (command === "status") { console.log(launchdStatus()); return; }
  throw new Error(`Unknown command: ${command}`);
}

// Only the entry point runs a command; a test that imports serveOptions
// must not start a server.
if (import.meta.main) void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
