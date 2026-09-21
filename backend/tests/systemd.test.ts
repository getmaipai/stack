import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installSystemdService, renderSystemdUnit, startSystemdService, stopSystemdService, systemdStatus, systemdUnitPath, uninstallSystemdService } from "@/service/systemd";
import { __setNotifySenderForTests, notifySystemd, startSystemdWatchdog } from "@/service/notify";

const original = { HOME: process.env.HOME, DATA: process.env.STACK_DATA_DIR, NAME: process.env.STACK_SERVICE_NAME, SYSTEMCTL: process.env.STACK_SYSTEMCTL, PORT: process.env.PORT, SOCKET: process.env.NOTIFY_SOCKET, USEC: process.env.WATCHDOG_USEC, BUN_BIN: process.env.STACK_BUN_BIN };
const root = mkdtempSync(join(tmpdir(), "maipai-stack-systemd-"));
const home = join(root, "home");
const data = join(root, "data");
const log = join(root, "systemctl.log");
const shim = join(root, "systemctl");

beforeAll(() => {
  writeFileSync(shim, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SYSTEMCTL_LOG\"\n"); chmodSync(shim, 0o755);
  process.env.HOME = home; process.env.STACK_DATA_DIR = data; process.env.STACK_SERVICE_NAME = "maipai-stack-test"; process.env.STACK_SYSTEMCTL = shim; process.env.SYSTEMCTL_LOG = log; process.env.PORT = "8771";
});

afterAll(() => {
  for (const [key, value] of [["HOME", original.HOME], ["STACK_DATA_DIR", original.DATA], ["STACK_SERVICE_NAME", original.NAME], ["STACK_SYSTEMCTL", original.SYSTEMCTL], ["PORT", original.PORT], ["NOTIFY_SOCKET", original.SOCKET], ["WATCHDOG_USEC", original.USEC], ["STACK_BUN_BIN", original.BUN_BIN]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  delete process.env.SYSTEMCTL_LOG; __setNotifySenderForTests(null); rmSync(root, { recursive: true, force: true });
});

test("renders the unit the services standard names and drives systemctl --user through install, start, stop and uninstall", () => {
  const binary = "/home/marlow/.maipai/stack/bin/maipai-stack";
  const unit = renderSystemdUnit(binary, data);
  for (const line of ["Type=notify", `ExecStart="${binary}" serve`, "Restart=on-failure", "WatchdogSec=30", "StartLimitBurst=5", "StartLimitIntervalSec=300", `Environment="STACK_DATA_DIR=${data}"`, "Environment=PORT=8771", `StandardOutput=append:${data}/logs/stack.log`, `StandardError=append:${data}/logs/stack.error.log`, "WantedBy=default.target"]) expect(unit).toContain(line);
  expect(installSystemdService(binary)).toBe(join(home, ".config/systemd/user/maipai-stack-test.service"));
  expect(readFileSync(systemdUnitPath(), "utf8")).toBe(unit);
  expect(existsSync(join(data, "logs"))).toBe(true);
  let calls = readFileSync(log, "utf8");
  expect(calls).toContain("--user daemon-reload");
  expect(calls).toContain("--user enable maipai-stack-test.service");
  expect(calls).toContain("--user restart maipai-stack-test.service");
  startSystemdService(); stopSystemdService(); systemdStatus();
  calls = readFileSync(log, "utf8");
  expect(calls).toContain("--user start maipai-stack-test.service");
  expect(calls).toContain("--user stop maipai-stack-test.service");
  expect(calls).toContain("--user status --no-pager maipai-stack-test.service");
  uninstallSystemdService();
  expect(existsSync(systemdUnitPath())).toBe(false);
  expect(readFileSync(log, "utf8")).toContain("--user disable --now maipai-stack-test.service");
});

test("carries STACK_BUN_BIN into the unit's own environment when set (getmaipai/stack#8's fix), omitted when unset", () => {
  process.env.STACK_BUN_BIN = "/usr/local/bin/bun";
  expect(renderSystemdUnit("/home/marlow/.maipai/stack/bin/maipai-stack", data)).toContain('Environment="STACK_BUN_BIN=/usr/local/bin/bun"');
  delete process.env.STACK_BUN_BIN;
  expect(renderSystemdUnit("/home/marlow/.maipai/stack/bin/maipai-stack", data)).not.toContain("STACK_BUN_BIN");
});

test("a path with a space or a percent sign is quoted and escaped in the unit", () => {
  const unit = renderSystemdUnit("/home/marlow/My Apps/maipai-stack", "/home/marlow/My Data/50%");
  expect(unit).toContain('ExecStart="/home/marlow/My Apps/maipai-stack" serve');
  expect(unit).toContain('Environment="STACK_DATA_DIR=/home/marlow/My Data/50%%"');
  expect(unit).toContain("StandardOutput=append:/home/marlow/My Data/50%%/logs/stack.log");
});

test("sd_notify is a no-op without NOTIFY_SOCKET and sends the state line with it; the watchdog beats at half WATCHDOG_USEC", async () => {
  const sent: Array<{ socketPath: string; message: string }> = [];
  __setNotifySenderForTests((socketPath, message) => { sent.push({ socketPath, message }); return true; });
  delete process.env.NOTIFY_SOCKET;
  expect(notifySystemd("READY=1")).toBe(false);
  expect(sent).toEqual([]);
  process.env.NOTIFY_SOCKET = "/run/user/1000/systemd/notify";
  expect(notifySystemd("READY=1")).toBe(true);
  expect(sent).toEqual([{ socketPath: "/run/user/1000/systemd/notify", message: "READY=1\n" }]);
  delete process.env.WATCHDOG_USEC;
  expect(typeof startSystemdWatchdog()).toBe("function");
  process.env.WATCHDOG_USEC = String(2_000 * 1000);
  const stop = startSystemdWatchdog();
  await new Promise((resolve) => setTimeout(resolve, 1_300));
  stop();
  expect(sent.filter((entry) => entry.message === "WATCHDOG=1\n").length).toBeGreaterThanOrEqual(1);
});
