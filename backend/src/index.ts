import { app } from "@/app";
import { installLaunchdService, launchdStatus, startLaunchdService, stopLaunchdService, uninstallLaunchdService } from "@/service/launchd";
import { startDetection } from "@/lib/detect";
import { startMaintenanceScheduler } from "@/lib/maintenance";
import { activateStackConfig, stackSettingValues } from "@/settings/stackKeys";

const port = Number(process.env.PORT ?? 8770);

async function openBrowser(): Promise<void> {
  const url = `http://127.0.0.1:${port}/`;
  const result = Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
  await result.exited;
}

export function serveOptions(): { port: number; hostname: string; fetch: (request: Request) => Response | Promise<Response>; idleTimeout: number } {
  return { port, hostname: stackSettingValues().lanAccess === true ? "0.0.0.0" : "127.0.0.1", fetch: app.fetch, idleTimeout: 255 };
}

async function serve(): Promise<void> {
  activateStackConfig();
  const server = Bun.serve(serveOptions());
  const stopDetection = startDetection();
  const stopMaintenance = startMaintenanceScheduler();
  let stopping = false;
  const stop = async (exitCode: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    stopDetection();
    stopMaintenance();
    server.stop(true);
    process.exitCode = exitCode;
  };
  process.once("SIGTERM", () => { void stop(0); });
  process.once("SIGINT", () => { void stop(0); });
  process.once("uncaughtException", (error) => { console.error(error); void stop(1); });
  console.log(`Health: http://127.0.0.1:${port}/healthz`);
  console.log(`Docs: http://127.0.0.1:${port}/api/docs`);
  await new Promise<void>((resolve) => {
    const check = setInterval(() => { if (stopping) { clearInterval(check); resolve(); } }, 25);
    (check as unknown as { unref?: () => void }).unref?.();
  });
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  if (command === "serve") return serve();
  if (command === "install-service") { console.log(`Installed ${installLaunchdService(process.env.STACK_SERVICE_PROGRAM ?? process.execPath)}`); return; }
  if (command === "uninstall-service") { uninstallLaunchdService(); if (process.argv.includes("--remove-data")) { const { rmSync } = await import("node:fs"); const { resolve } = await import("node:path"); const data = process.env.STACK_DATA_DIR ? resolve(process.env.STACK_DATA_DIR) : ""; if (data) rmSync(data, { recursive: true, force: true }); console.log("Service and data removed."); } else console.log("Service removed. Data was kept."); return; }
  if (command === "start") { startLaunchdService(); console.log("Service started."); return; }
  if (command === "stop") { stopLaunchdService(); console.log("Service stopped."); return; }
  if (command === "status") { console.log(launchdStatus()); return; }
  if (command === "open") { await openBrowser(); return; }
  throw new Error(`Unknown command: ${command}`);
}

void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
