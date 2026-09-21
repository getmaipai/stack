import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { dataDir as defaultDataDir } from "@/lib/paths";

export const DEFAULT_SERVICE_LABEL = "com.maipai.stack";

function serviceLabel(): string { return process.env.STACK_SERVICE_LABEL ?? DEFAULT_SERVICE_LABEL; }
function homeDir(): string { return process.env.HOME ?? homedir(); }
function launchAgentsDir(): string { return join(homeDir(), "Library", "LaunchAgents"); }
export function launchAgentPath(): string { return join(launchAgentsDir(), `${serviceLabel()}.plist`); }
function serviceDataDir(): string { return resolve(process.env.STACK_DATA_DIR ?? defaultDataDir); }
function portEnvironment(): string { return process.env.PORT ? `\n  <key>PORT</key><string>${xml(process.env.PORT)}</string>` : ""; }
// The bun binary the compiled daemon re-invokes the stt worker through
// (lib/supervisor.ts's speechWorkerCommand(), getmaipai/stack#8) -
// baked into the unit at install time the same way PORT already is,
// since a launchd unit's own EnvironmentVariables is the one thing
// that reaches every later `serve` without the installer having to set
// it again on every boot.
function bunBinEnvironment(): string { return process.env.STACK_BUN_BIN ? `\n  <key>STACK_BUN_BIN</key><string>${xml(process.env.STACK_BUN_BIN)}</string>` : ""; }
function uid(): number { return typeof process.getuid === "function" ? process.getuid() : Number(process.env.USER_ID ?? 0); }
function launchTarget(): string { return `gui/${uid()}/${serviceLabel()}`; }

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function renderLaunchdPlist(binaryPath: string, dataDirectory = serviceDataDir()): string {
  const logs = join(dataDirectory, "logs");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(serviceLabel())}</string>
  <key>Program</key><string>${xml(binaryPath)}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(binaryPath)}</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(join(logs, "stack.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logs, "stack.error.log"))}</string>
  <key>EnvironmentVariables</key>
  <dict><key>STACK_DATA_DIR</key><string>${xml(dataDirectory)}</string>${portEnvironment()}${bunBinEnvironment()}</dict>
</dict>
</plist>
`;
}

function launchctl(args: string[], allowFailure = false): string {
  const command = process.env.STACK_LAUNCHCTL ?? "launchctl";
  const result = spawnSync(command, args, { encoding: "utf8", env: process.env });
  if (result.error && !allowFailure) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(result.stderr?.trim() || `launchctl ${args.join(" ")} failed.`);
  }
  return result.stdout ?? "";
}

export function installLaunchdService(binaryPath = process.env.STACK_SERVICE_PROGRAM ?? process.execPath): string {
  const dataDirectory = serviceDataDir();
  mkdirSync(join(dataDirectory, "logs"), { recursive: true, mode: 0o700 });
  mkdirSync(launchAgentsDir(), { recursive: true, mode: 0o700 });
  if (existsSync(launchAgentPath())) launchctl(["bootout", `gui/${uid()}/${serviceLabel()}`], true);
  writeFileSync(launchAgentPath(), renderLaunchdPlist(binaryPath, dataDirectory), { mode: 0o600 });
  launchctl(["bootstrap", `gui/${uid()}`, launchAgentPath()]);
  return launchAgentPath();
}

export function startLaunchdService(): void {
  if (!existsSync(launchAgentPath())) throw new Error(`Service is not installed at ${launchAgentPath()}.`);
  launchctl(["bootstrap", `gui/${uid()}`, launchAgentPath()]);
}

export function stopLaunchdService(): void {
  launchctl(["bootout", launchTarget()], true);
}

export function restartLaunchdService(): void {
  stopLaunchdService();
  startLaunchdService();
}

export function uninstallLaunchdService(): void {
  stopLaunchdService();
  if (existsSync(launchAgentPath())) unlinkSync(launchAgentPath());
}

export function launchdStatus(): string {
  return launchctl(["print", launchTarget()], true).trim() || "Service is not running.";
}
