// The Tailscale admin address the Stack reports (GET /stack/v1/admin-access): the real state of the listener, never a guess from the setting alone.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { __resetAdminAccessForTests, adminAccess, recordTailscaleListener } from "@/lib/adminAccess";
import { app } from "@/app";
import { __resetSettingsForTests, applyPendingSettings, updateSettings } from "@/settings";

const TOKEN = "t".repeat(40);
const previous = process.env.STACK_HOME_VIEW_TOKEN;
beforeEach(() => { process.env.STACK_HOME_VIEW_TOKEN = TOKEN; __resetSettingsForTests(); __resetAdminAccessForTests(); });
afterEach(() => { __resetSettingsForTests(); __resetAdminAccessForTests(); if (previous === undefined) delete process.env.STACK_HOME_VIEW_TOKEN; else process.env.STACK_HOME_VIEW_TOKEN = previous; });

test("off by default: says how to turn it on and gives no address", () => {
  const { tailscale } = adminAccess("100.101.102.103");
  expect(tailscale.state).toBe("off");
  expect(tailscale.url).toBeNull();
  expect(tailscale.message).toContain("Turn on");
});

test("on but not yet restarted: restart pending, no url, and the address it will use", () => {
  updateSettings({ "stack.admin.tailscale": true });
  const { tailscale } = adminAccess("100.101.102.103");
  expect(tailscale.state).toBe("restart_pending");
  expect(tailscale.url).toBeNull();
  expect(tailscale.address).toBe("100.101.102.103");
  expect(tailscale.message).toContain("restarts");
});

test("on and bound at start: listening, with the sign-in page on the tailnet address", () => {
  updateSettings({ "stack.admin.tailscale": true });
  applyPendingSettings();
  recordTailscaleListener({ address: "100.101.102.103", port: 8770 });
  const { tailscale } = adminAccess("100.101.102.103");
  expect(tailscale.state).toBe("listening");
  expect(tailscale.url).toBe("http://100.101.102.103:8770/admin/");
});

test("on at start but nothing bound: says the computer has no Tailscale address", () => {
  updateSettings({ "stack.admin.tailscale": true });
  applyPendingSettings();
  recordTailscaleListener(null);
  const { tailscale } = adminAccess(null);
  expect(tailscale.state).toBe("no_address");
  expect(tailscale.url).toBeNull();
  expect(tailscale.message).toContain("Tailscale");
});

test("on at start with nothing bound but a Tailscale address now: restart pending, not no address", () => {
  updateSettings({ "stack.admin.tailscale": true });
  applyPendingSettings();
  recordTailscaleListener(null);
  const { tailscale } = adminAccess("100.101.102.103");
  expect(tailscale.state).toBe("restart_pending");
  expect(tailscale.address).toBe("100.101.102.103");
  expect(tailscale.message).toContain("Restart the Stack");
});

test("the route answers Home with the same report", async () => {
  const response = await app.fetch(new Request("http://127.0.0.1:8770/stack/v1/admin-access", { headers: { host: "127.0.0.1:8770", authorization: `Bearer ${TOKEN}` } }));
  expect(response.status).toBe(200);
  const body = await response.json() as { tailscale: { state: string } };
  expect(["off", "restart_pending", "listening", "no_address"]).toContain(body.tailscale.state);
});
