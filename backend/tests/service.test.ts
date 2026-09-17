import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installLaunchdService, launchAgentPath, renderLaunchdPlist, uninstallLaunchdService } from "@/service/launchd";

const original = { HOME: process.env.HOME, DATA: process.env.STACK_DATA_DIR, LABEL: process.env.STACK_SERVICE_LABEL, LAUNCHCTL: process.env.STACK_LAUNCHCTL };
const root = mkdtempSync(join(tmpdir(), "maipai-stack-service-"));
const home = join(root, "home");
const data = join(root, "data");
const log = join(root, "launchctl.log");
const shim = join(root, "launchctl");

beforeAll(() => {
  writeFileSync(shim, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$LAUNCHCTL_LOG\"\n"); chmodSync(shim, 0o755);
  process.env.HOME = home; process.env.STACK_DATA_DIR = data; process.env.STACK_SERVICE_LABEL = "com.maipai.stack.test"; process.env.STACK_LAUNCHCTL = shim; process.env.LAUNCHCTL_LOG = log;
});

afterAll(() => {
  if (original.HOME === undefined) delete process.env.HOME; else process.env.HOME = original.HOME;
  if (original.DATA === undefined) delete process.env.STACK_DATA_DIR; else process.env.STACK_DATA_DIR = original.DATA;
  if (original.LABEL === undefined) delete process.env.STACK_SERVICE_LABEL; else process.env.STACK_SERVICE_LABEL = original.LABEL;
  if (original.LAUNCHCTL === undefined) delete process.env.STACK_LAUNCHCTL; else process.env.STACK_LAUNCHCTL = original.LAUNCHCTL;
  delete process.env.LAUNCHCTL_LOG; rmSync(root, { recursive: true, force: true });
});

test("renders the launchd settings and starts the temporary agent", () => {
  const binary = "/Users/test/.maipai/stack/bin/maipai-stack";
  const plist = renderLaunchdPlist(binary, data);
  expect(plist).toContain("<key>Program</key><string>/Users/test/.maipai/stack/bin/maipai-stack</string>");
  expect(plist).toContain("<key>RunAtLoad</key><true/>");
  expect(plist).toContain("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>");
  expect(plist).toContain("<key>ThrottleInterval</key><integer>30</integer>");
  expect(plist).toContain(`<key>StandardOutPath</key><string>${data}/logs/stack.log</string>`);
  expect(plist).toContain(`<key>StandardErrorPath</key><string>${data}/logs/stack.error.log</string>`);
  expect(plist).toContain(`<key>STACK_DATA_DIR</key><string>${data}</string>`);
  expect(installLaunchdService(binary)).toBe(join(home, "Library/LaunchAgents/com.maipai.stack.test.plist"));
  expect(readFileSync(launchAgentPath(), "utf8")).toBe(plist);
  expect(readFileSync(log, "utf8")).toContain(`bootstrap gui/${process.getuid?.() ?? 0} ${launchAgentPath()}`);
  uninstallLaunchdService();
  expect(readFileSync(log, "utf8")).toContain(`bootout gui/${process.getuid?.() ?? 0}/com.maipai.stack.test`);
});
