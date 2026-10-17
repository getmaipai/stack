// The daemon: `serve` runs it on loopback; the other commands operate
// the service unit Home's installer created. Exit codes mean what they
// say: 0 on a clean stop, 1 on a fatal error, so the service manager's
// restart policy is the outer watchdog. index.ts dispatches here; the
// speech worker never imports this file, so it never opens the database.
import { app, websocket } from "@/app";
import { logger } from "@/lib/log";
import { installLaunchdService, launchdStatus, startLaunchdService, stopLaunchdService, uninstallLaunchdService } from "@/service/launchd";
import { installSystemdService, startSystemdService, stopSystemdService, systemdStatus, uninstallSystemdService } from "@/service/systemd";
import { notifySystemd, startSystemdWatchdog } from "@/service/notify";
import { applyPendingSettings, settingValues } from "@/settings";
import { setMachineTierFromHardware, stopAllRoles, unloadIdleRoles } from "@/lib/supervisor";
import { keepWarmEnabled, warmUp, warmedRoles } from "@/lib/warmup";
import { migrateLegacyEngineTags } from "@/lib/engineInstall";
import { reconcilePinDeclarations } from "@/lib/modelStore";
import { pullMissingDeclaredParts } from "@/lib/installJobs";
import { STACK_MODELS } from "@/lib/modelCatalog";
import { ddgsSupervisor } from "@/search/ddgsSidecar";
import { imageTools, sweepImageToolsTmp } from "@/imagetools/imageTools";
import { videoGen } from "@/video/videoGen";
import { imageGen } from "@/images/imageEngine";
import { sweepImageTmp, sweepResults as sweepImageResults } from "@/images/results";
import { sweepResults, sweepVideoTmp } from "@/video/results";
import { execFileSync } from "node:child_process";
import { readMetalCapBytes } from "@/lib/metalCap";
import { setMetalCapBytes, getGovernorStatus } from "@/lib/governor";

/** Bun's default request body limit is 128 MB; a LoRA upload (VIDEO-GEN-03) may be up to 2 GB, so the limit leaves room for it. Every route checks its own size. */
export const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024 * 1024 + 64 * 1024 * 1024;

export function serveOptions(): { port: number; hostname: "127.0.0.1"; fetch: (request: Request, server: unknown) => Response | Promise<Response>; websocket: typeof websocket; idleTimeout: number; maxRequestBodySize: number } {
  const port = Number(process.env.PORT ?? settingValues()["stack.runtime.port"] ?? 8770);
  return { port, hostname: "127.0.0.1", fetch: app.fetch as (request: Request, server: unknown) => Response | Promise<Response>, websocket, idleTimeout: 255, maxRequestBodySize: MAX_REQUEST_BODY_BYTES };
}

function onBattery(): boolean {
  if (process.platform !== "darwin") return false;
  try { return /Now drawing from ['"]Battery Power/.test(execFileSync("pmset", ["-g", "batt"], { encoding: "utf8", timeout: 1_000 })); } catch { return false; }
}

async function serve(): Promise<void> {
  logger.installConsoleMirror();
  for (const moved of migrateLegacyEngineTags()) console.log(`Renamed engine ${moved.name} ${moved.from} to ${moved.to}.`);
  applyPendingSettings();
  // An installed model gets what its pin now declares (picture input) before anything launches.
  for (const id of reconcilePinDeclarations(STACK_MODELS)) console.log(`Updated the record of ${id} to match its pin.`);
  // The governor's working margin follows the machine's tier from here on.
  const { tier, stop: stopTierWatch } = await setMachineTierFromHardware();
  void readMetalCapBytes().then((bytes) => {
    const previousCapBytes = getGovernorStatus().capBytes;
    setMetalCapBytes(bytes);
    logger.appendLine(JSON.stringify({ event: "governor.metal-cap", bytes, loweredCap: bytes !== null && bytes < previousCapBytes }));
  }).catch(() => {});
  console.log(`Machine tier ${tier ?? "unknown (the p16 margin applies)"}.`);
  const options = serveOptions();
  const server = Bun.serve(options);
  // Under systemd (Type=notify) the unit is "started" only now, and the
  // watchdog is answered from here on; elsewhere both are no-ops.
  notifySystemd("READY=1");
  const stopWatchdog = startSystemdWatchdog();
  // Load and prime the roles a first chat needs, now, so nobody meets a cold start.
  // An upgrade installs no plan: a part an installed model declares (its picture projector) is pulled now (VISION-03g), then chat restarts with it.
  void pullMissingDeclaredParts().catch(() => {});
  void warmUp("daemon-start").catch(() => {});
  // The DuckDuckGo search service Home's web search uses: built, started and restarted here; it never fails the Stack.
  ddgsSupervisor.start();
  // Pictures an earlier crash left in the image tools' temporary folder are removed; the worker itself starts on the first edit.
  sweepImageToolsTmp();
  // Clips an earlier run left half-made are removed and old results swept; the video worker itself starts on the first clip and exits after ten idle minutes.
  sweepVideoTmp();
  sweepResults();
  // The same for pictures (IMGGEN-STACK-02): half-made work removed, old results swept; the picture worker starts on the first request and exits after ten idle minutes.
  sweepImageTmp();
  sweepImageResults();
  const idle = setInterval(() => {
    const values = settingValues();
    void unloadIdleRoles({ onBattery: onBattery(), idleMinutes: Number(values["stack.runtime.idle_unload_minutes"] ?? 30), batteryIdleMinutes: Number(values["stack.runtime.idle_unload_on_battery_minutes"] ?? 10), keep: keepWarmEnabled() ? warmedRoles() : [] }).catch(() => {});
  }, 60_000);
  (idle as unknown as { unref?: () => void }).unref?.();
  let stopping = false;
  const stop = async (exitCode: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    notifySystemd("STOPPING=1");
    clearInterval(idle);
    // The watchdog keeps beating through the drain: a stop that takes
    // longer than WatchdogSec must not be mistaken for a hang.
    await ddgsSupervisor.stop().catch(() => {});
    imageTools.stop();
    videoGen.stop();
    imageGen.stop();
    await stopAllRoles("The Stack is stopping.");
    stopTierWatch();
    stopWatchdog();
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

// The service manager for this platform: launchd on macOS, systemd
// --user on Linux (the robot). Same commands, same data layout.
const service = process.platform === "linux"
  ? { install: installSystemdService, uninstall: uninstallSystemdService, start: startSystemdService, stop: stopSystemdService, status: systemdStatus }
  : { install: installLaunchdService, uninstall: uninstallLaunchdService, start: startLaunchdService, stop: stopLaunchdService, status: launchdStatus };

export async function runDaemonCommand(command: string): Promise<void> {
  if (command === "serve") return serve();
  if (command === "install-service") { console.log(`Installed ${service.install(process.env.STACK_SERVICE_PROGRAM ?? process.execPath)}`); return; }
  if (command === "uninstall-service") {
    service.uninstall();
    if (process.argv.includes("--remove-data")) {
      const { rmSync } = await import("node:fs"); const { resolve } = await import("node:path");
      const data = process.env.STACK_DATA_DIR ? resolve(process.env.STACK_DATA_DIR) : "";
      if (data) rmSync(data, { recursive: true, force: true });
      console.log("Service and data removed.");
    } else console.log("Service removed. Data was kept.");
    return;
  }
  if (command === "start") { service.start(); console.log("Service started."); return; }
  if (command === "stop") { service.stop(); console.log("Service stopped."); return; }
  if (command === "status") { console.log(service.status()); return; }
  throw new Error(`Unknown command: ${command}`);
}
