// The daemon: `serve` runs it on loopback; the other commands operate
// the service unit Home's installer created. Exit codes mean what they
// say: 0 on a clean stop, 1 on a fatal error, so the service manager's
// restart policy is the outer watchdog. index.ts dispatches here; the
// speech worker never imports this file, so it never opens the database.
import { app, websocket } from "@/app";
import { adminGuardedFetch } from "@/lib/adminGuard";
import { pickTailscaleAddress } from "@/lib/adminListener";
import { createSetupCode, resetAdmin } from "@/lib/adminAuth";
import { dataDir } from "@/lib/paths";
import { homeViewToken } from "@/lib/adultView";
import { logger } from "@/lib/log";
import { installLaunchdService, launchdStatus, startLaunchdService, stopLaunchdService, uninstallLaunchdService } from "@/service/launchd";
import { installSystemdService, startSystemdService, stopSystemdService, systemdStatus, uninstallSystemdService } from "@/service/systemd";
import { notifySystemd, startSystemdWatchdog } from "@/service/notify";
import { applyPendingSettings, settingValues } from "@/settings";
import { setMachineTierFromHardware, stopAllRoles, unloadIdleRoles } from "@/lib/supervisor";
import { keepWarmEnabled, warmUp, warmedRoles } from "@/lib/warmup";
import { migrateLegacyEngineTags } from "@/lib/engineInstall";
import { reconcilePinDeclarations } from "@/lib/modelStore";
import { resumeMoveJobs } from "@/lib/moveModels";
import { pullMissingDeclaredParts } from "@/lib/installJobs";
import { ensureChatEngineAssets } from "@/lib/chatEngineAssets";
import { STACK_MODELS, STACK_STEMS_MODELS, STACK_VOICE_CONVERT_MODELS } from "@/lib/modelCatalog";
import { startSelfHeal } from "@/lib/selfHeal";
import { ddgsSupervisor } from "@/search/ddgsSidecar";
import { imageTools } from "@/imagetools/imageTools";
import { livePortrait } from "@/liveportrait/liveportrait";
import { lookService } from "@/look/look";
import { packs } from "@/packs/loader";
import { splashSpec } from "@/engines/splash/spec";
import { heavyGate, recoverPausedWorkers } from "@/lib/heavyGate";
import { hostLimiter } from "@/media/hosts";
import { videoGen } from "@/video/videoGen";
import { musicGen } from "@/music/musicGen";
import { sfxGen } from "@/sound/sfxGen";
import { stopScoreWorkers } from "@/score/scoreGen";
import { imageGen } from "@/images/imageEngine";
import { runSweeps } from "@/lib/sweeps";
import { retireModels } from "@/lib/retireModels";
import { sandboxService, startSandboxSweeper } from "@/lib/sandbox";
import { beginStopping } from "@/lib/lifecycle";
import { startMemoryWatchdog } from "@/lib/memoryWatchdog";
import { startResourceHistory } from "@/lib/resourceHistory";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/db";
import { admin } from "@/db/schema";
import { readMetalCapBytes } from "@/lib/metalCap";
import { setMetalCapBytes, getGovernorStatus } from "@/lib/governor";
import { wireMaxWindowReduced } from "@/lib/maxWindowReduced";
import { resetReducedChatOnBoot } from "@/lib/reducedChatLease";
import { setupHomeModeRuntime } from "@/lib/homeModeRuntime";
import { checkEngineUpdates } from "@/lib/engineUpdates";

/** Bun's default request body limit is 128 MB; a LoRA upload (VIDEO-GEN-03) may be up to 2 GB, so the limit leaves room for it. Every route checks its own size. */
export const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024 * 1024 + 64 * 1024 * 1024;

export function serveOptions(): { port: number; hostname: "127.0.0.1"; fetch: (request: Request, server: unknown) => Response | Promise<Response>; websocket: typeof websocket; idleTimeout: number; maxRequestBodySize: number } {
  const port = Number(process.env.PORT ?? settingValues()["stack.runtime.port"] ?? 8770);
  return { port, hostname: "127.0.0.1", fetch: adminGuardedFetch(app.fetch as (request: Request, server: unknown) => Response | Promise<Response>), websocket, idleTimeout: 255, maxRequestBodySize: MAX_REQUEST_BODY_BYTES };
}

/** The second listener for the admin page on the Tailscale address, or null when the setting is off or no Tailscale address exists. Every /stack/v1 request on it needs an admin session. */
export function tailscaleServeOptions(base: ReturnType<typeof serveOptions>, address: string | null = pickTailscaleAddress()): (Omit<ReturnType<typeof serveOptions>, "hostname"> & { hostname: string }) | null {
  if (!settingValues()["stack.admin.tailscale"] || !address) return null;
  return { ...base, hostname: address, fetch: adminGuardedFetch(app.fetch as (request: Request, server: unknown) => Response | Promise<Response>, { tailscaleAddress: address }) };
}

function hasAdmin(): boolean { return db.select().from(admin).get() !== undefined; }

function onBattery(): boolean {
  if (process.platform !== "darwin") return false;
  try { return /Now drawing from ['"]Battery Power/.test(execFileSync("pmset", ["-g", "batt"], { encoding: "utf8", timeout: 1_000 })); } catch { return false; }
}

async function serve(): Promise<void> {
  logger.installConsoleMirror();
  for (const moved of migrateLegacyEngineTags()) console.log(`Renamed engine ${moved.name} ${moved.from} to ${moved.to}.`);
  applyPendingSettings();
  // Models the Stack no longer carries (Ornith 1.5 122B, retired 2026-11-21): records dropped, a saved choice that names one reset with a notice, Splash's layout of it removed. Their folders go through Tidy (the start-up sweep below).
  retireModels();
  // A model move that was cut off is finished or rolled back before anything launches.
  await resumeMoveJobs().catch((error) => console.log(`Could not finish an interrupted model move: ${error instanceof Error ? error.message : error}`));
  // An installed model gets what its pin now declares (picture input) before anything launches.
  for (const id of reconcilePinDeclarations([...STACK_MODELS, ...STACK_STEMS_MODELS, ...STACK_VOICE_CONVERT_MODELS])) console.log(`Updated the record of ${id} to match its pin.`);
  // TIER-ROUTES-01: the Max window swaps chat to Reduced and back by itself.
  resetReducedChatOnBoot();
  wireMaxWindowReduced();
  // The governor's working margin follows the machine's tier from here on.
  const { tier, stop: stopTierWatch } = await setMachineTierFromHardware();
  await setupHomeModeRuntime(settingValues()["stack.engines.coding.home_mode"] === "coding" ? "coding" : "normal");
  void readMetalCapBytes().then((bytes) => {
    const previousCapBytes = getGovernorStatus().capBytes;
    setMetalCapBytes(bytes);
    logger.appendLine(JSON.stringify({ event: "governor.metal-cap", bytes, loweredCap: bytes !== null && bytes < previousCapBytes }));
  }).catch(() => {});
  console.log(`Machine tier ${tier ?? "unknown (the p16 margin applies)"}.`);
  // ISOLATION-04: Home's token exists before the first request (an install made before this gets one here, with no data touched).
  homeViewToken();
  // MODELPACK-STACK-01: a model pack that does not validate stops the Stack here, with the folder and the fix in the message.
  logger.appendLine(JSON.stringify({ event: "packs.loaded", count: packs().length }));
  // ENGINESPEC-STACK-01: the same for the Splash engine data.
  logger.appendLine(JSON.stringify({ event: "engines.spec.loaded", engine: "splash", tiers: splashSpec().tiers }));
  const options = serveOptions();
  const server = Bun.serve(options);
  const tailscaleOptions = tailscaleServeOptions(options);
  const tailscaleServer = tailscaleOptions ? Bun.serve(tailscaleOptions) : null;
  if (tailscaleOptions && tailscaleServer) logger.appendLine(JSON.stringify({ event: "admin.tailscale.bound", address: tailscaleOptions.hostname, port: tailscaleServer.port }));
  else if (settingValues()["stack.admin.tailscale"]) logger.appendLine(JSON.stringify({ event: "admin.tailscale.unavailable", reason: "no Tailscale address (100.64.0.0/10) on this computer; only loopback is bound" }));
  // First run: no admin yet means a one-time setup code, printed once here and kept in a 0600 file.
  if (!hasAdmin() && !existsSync(join(dataDir, "admin-setup-code"))) {
    createSetupCode(dataDir);
    logger.appendLine(JSON.stringify({ event: "admin.setup-code.created", at: new Date().toISOString(), file: join(dataDir, "admin-setup-code") }));
    console.log(`No admin account yet. The one-time setup code is in ${join(dataDir, "admin-setup-code")} (only you can read it).`);
  }
  // Under systemd (Type=notify) the unit is "started" only now, and the
  // watchdog is answered from here on; elsewhere both are no-ops.
  notifySystemd("READY=1");
  const stopWatchdog = startSystemdWatchdog();
  // Load and prime the roles a first chat needs, now, so nobody meets a cold start.
  // An upgrade installs no plan: a part an installed model declares (its picture projector) is pulled now (VISION-03g), then chat restarts with it.
  void pullMissingDeclaredParts().catch(() => {});
  // The chat engine this tier runs by default (oMLX) is built and its model pulled in the background; chat moves onto it once both are verified (ENGINE-MLX-01).
  void ensureChatEngineAssets().catch(() => {});
  void warmUp("daemon-start").catch(() => {});
  // The DuckDuckGo search service Home's web search uses: built, started and restarted here; it never fails the Stack.
  ddgsSupervisor.start();
  // An engine that stops on its own is restarted here (ROBUST-01); the first look at startup finds a role that is offline with no process.
  const stopSelfHeal = startSelfHeal();
  // Pictures an earlier crash left in the image tools' temporary folder are removed; the worker itself starts on the first edit.
  // ISOLATION-01: a worker an earlier Stack left stopped (it was killed while a chat held the pause) is continued now.
  recoverPausedWorkers();
  // Media job folders nobody released within a week (Home was away) go; a site that asked the Stack to rest is still resting after a restart.
  hostLimiter.load();
  // The memory watchdog (2026-10-17): samples the whole computer every 5 s, gates generative starts on real free memory, and acts on pressure.
  const stopMemoryWatchdog = startMemoryWatchdog();
  const stopResourceHistory = startResourceHistory();
  // Clips an earlier run left half-made are removed and old results swept; the video worker itself starts on the first clip and exits after ten idle minutes.
  // Songs: half-made work removed and old results swept; the music worker starts on the first song and exits after five idle minutes.
  // The same for pictures (IMGGEN-STACK-02): half-made work removed, old results swept; the picture worker starts on the first request and exits after ten idle minutes.
  void runSweeps("start");
  // CODE-SANDBOX-01b: a sandbox machine nobody used for the idle time is stopped (its workspace stays).
  const stopSandboxSweeper = startSandboxSweeper(sandboxService(dataDir));
  const sweeps = setInterval(() => { void runSweeps("timer"); }, 10 * 60_000);
  (sweeps as unknown as { unref?: () => void }).unref?.();
  // Newer upstream releases of the programs the Stack installs: a public read at most once every 12 hours, off with the update checks.
  const releaseCheck = setInterval(() => { void checkEngineUpdates(); }, 60 * 60_000);
  (releaseCheck as unknown as { unref?: () => void }).unref?.();
  void checkEngineUpdates();
  const idle = setInterval(() => {
    const values = settingValues();
    // The coding engine unloads after its own keep-warm minutes, on battery or not, in place of the runtime-wide limits (CODE-STACK-01 S2).
    void unloadIdleRoles({ onBattery: onBattery(), idleMinutes: Number(values["stack.runtime.idle_unload_minutes"] ?? 30), batteryIdleMinutes: Number(values["stack.runtime.idle_unload_on_battery_minutes"] ?? 10), keep: keepWarmEnabled() ? warmedRoles() : [], roleIdleMinutes: { coding: Number(values["stack.engines.coding.keep_warm_minutes"] ?? 15) } }).catch(() => {});
  }, 60_000);
  (idle as unknown as { unref?: () => void }).unref?.();
  let stopping = false;
  const stop = async (exitCode: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    notifySystemd("STOPPING=1");
    // From here a new request gets 503 stack_restarting with Retry-After; Home retries after the restart.
    beginStopping();
    stopMemoryWatchdog();
    stopResourceHistory();
    clearInterval(idle);
    clearInterval(sweeps);
    stopSandboxSweeper();
    clearInterval(releaseCheck);
    stopSelfHeal();
    // ISOLATION-01: nothing is left stopped; each worker is continued before it is told to quit.
    heavyGate.resumeEverything("shutdown");
    // The watchdog keeps beating through the drain: a stop that takes
    // longer than WatchdogSec must not be mistaken for a hang.
    await ddgsSupervisor.stop().catch(() => {});
    imageTools.stop();
    livePortrait.stop();
    lookService.stop();
    videoGen.stop();
    musicGen.stop();
    sfxGen.stop();
    stopScoreWorkers();
    imageGen.stop();
    await stopAllRoles("The Stack is stopping.", "stack-stopping");
    stopTierWatch();
    stopWatchdog();
    server.stop(true);
    tailscaleServer?.stop(true);
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
  if (command === "admin" && process.argv[3] === "reset") {
    await resetAdmin(dataDir);
    logger.appendLine(JSON.stringify({ event: "admin.reset", at: new Date().toISOString(), remote: "local" }));
    console.log(`Admin account removed and every sign-in ended. A new one-time setup code is in ${join(dataDir, "admin-setup-code")} (only you can read it). Open the admin page and enter it.`);
    return;
  }
  if (command === "start") { service.start(); console.log("Service started."); return; }
  if (command === "stop") { service.stop(); console.log("Service stopped."); return; }
  if (command === "status") { console.log(service.status()); return; }
  throw new Error(`Unknown command: ${command}`);
}
