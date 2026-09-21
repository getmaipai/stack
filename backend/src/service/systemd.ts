// The Linux service: a `systemd --user` unit with the restart policy the
// org SERVICES.md table names (Restart=on-failure, WatchdogSec=30,
// StartLimitBurst=5), logs under the data directory, the same commands
// as launchd.ts. The daemon answers the watchdog itself (notify.ts).
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { dataDir as defaultDataDir } from "@/lib/paths";

export const DEFAULT_SERVICE_NAME = "maipai-stack";

function serviceName(): string { return process.env.STACK_SERVICE_NAME ?? DEFAULT_SERVICE_NAME; }
function homeDir(): string { return process.env.HOME ?? homedir(); }
function unitDir(): string { return join(homeDir(), ".config", "systemd", "user"); }
export function systemdUnitPath(): string { return join(unitDir(), `${serviceName()}.service`); }
function serviceDataDir(): string { return resolve(process.env.STACK_DATA_DIR ?? defaultDataDir); }

// A unit value with a space splits on it and a `%` is a specifier, so
// paths are double-quoted with `"` and `\` escaped, and `%` doubled
// (systemd.syntax(7)); the launchd renderer XML-escapes the same way.
function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

export function renderSystemdUnit(binaryPath: string, dataDirectory = serviceDataDir()): string {
  const logs = join(dataDirectory, "logs");
  const port = process.env.PORT ? `Environment=PORT=${process.env.PORT}\n` : "";
  // Same reasoning as launchd.ts's own bunBinEnvironment(): the bun
  // binary the compiled daemon re-invokes the stt worker through
  // (lib/supervisor.ts's speechWorkerCommand(), getmaipai/stack#8),
  // baked in at install time. Untested on Linux this session (the
  // compiled build itself is darwin-only for now); kept in sync with
  // launchd.ts's own shape rather than left to drift.
  const bunBin = process.env.STACK_BUN_BIN ? `Environment=${quote(`STACK_BUN_BIN=${process.env.STACK_BUN_BIN}`)}\n` : "";
  return `[Unit]
Description=MaiPai Stack, the engine foundation of MaiPai Home
After=network.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=notify
NotifyAccess=main
ExecStart=${quote(binaryPath)} serve
Environment=${quote(`STACK_DATA_DIR=${dataDirectory}`)}
${port}${bunBin}Restart=on-failure
RestartSec=5
WatchdogSec=30
StandardOutput=append:${join(logs, "stack.log").replaceAll("%", "%%")}
StandardError=append:${join(logs, "stack.error.log").replaceAll("%", "%%")}

[Install]
WantedBy=default.target
`;
}

function systemctl(args: string[], allowFailure = false): string {
  const command = process.env.STACK_SYSTEMCTL ?? "systemctl";
  const result = spawnSync(command, ["--user", ...args], { encoding: "utf8", env: process.env });
  if (result.error && !allowFailure) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(result.stderr?.trim() || `systemctl --user ${args.join(" ")} failed.`);
  return result.stdout ?? "";
}

export function installSystemdService(binaryPath = process.env.STACK_SERVICE_PROGRAM ?? process.execPath): string {
  const dataDirectory = serviceDataDir();
  mkdirSync(join(dataDirectory, "logs"), { recursive: true, mode: 0o700 });
  mkdirSync(unitDir(), { recursive: true, mode: 0o700 });
  writeFileSync(systemdUnitPath(), renderSystemdUnit(binaryPath, dataDirectory), { mode: 0o600 });
  systemctl(["daemon-reload"]);
  systemctl(["enable", `${serviceName()}.service`]);
  // `restart`, not `enable --now`: a reinstall with a new binary (a Home
  // update) must replace the daemon that is running, the way launchd's
  // bootout-then-bootstrap does.
  systemctl(["restart", `${serviceName()}.service`]);
  return systemdUnitPath();
}

export function startSystemdService(): void {
  if (!existsSync(systemdUnitPath())) throw new Error(`Service is not installed at ${systemdUnitPath()}.`);
  systemctl(["start", `${serviceName()}.service`]);
}

export function stopSystemdService(): void {
  systemctl(["stop", `${serviceName()}.service`], true);
}

export function uninstallSystemdService(): void {
  systemctl(["disable", "--now", `${serviceName()}.service`], true);
  if (existsSync(systemdUnitPath())) unlinkSync(systemdUnitPath());
  systemctl(["daemon-reload"], true);
}

export function systemdStatus(): string {
  return systemctl(["status", "--no-pager", `${serviceName()}.service`], true).trim() || "Service is not running.";
}
