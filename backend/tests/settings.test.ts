import { afterEach, expect, test } from "bun:test";
import { app } from "@/app";
import { setUpdatesEnabled } from "@/updates/check";
import { __resetStackSettingsForTests } from "@/settings/stackKeys";
import { getGovernorStatus } from "@/lib/governor";
import { __resetOperatorForTests } from "@/lib/operator";

afterEach(() => { setUpdatesEnabled(false); __resetStackSettingsForTests(); __resetOperatorForTests(); });

test("Stack settings route serves grouped declarations and keeps LAN access pending until restart", async () => {
  const response = await app.request("/stack/v1/settings");
  expect(response.status).toBe(200);
  const initial = await response.json() as { settings: Array<{ key: string; group?: string; pending: unknown }> };
  expect(initial.settings.map((setting) => setting.key)).toEqual(expect.arrayContaining(["stackName", "theme", "updatesEnabled", "lanAccess", "port", "historyRetention", "logLevel", "modelBudgetBytes"]));
  expect(initial.settings.every((setting) => setting.group)).toBe(true);
  const setup = await app.request("/stack/v1/operator/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test password" }) });
  const cookie = setup.headers.get("set-cookie")?.split(";")[0] ?? "";
  const updated = await app.request("/stack/v1/settings", { method: "PUT", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ updatesEnabled: true, lanAccess: true }) });
  expect(updated.status).toBe(200);
  const body = await updated.json() as { settings: Array<{ key: string; inEffect: unknown; pending: unknown }> };
  expect(body.settings.find((setting) => setting.key === "updatesEnabled")?.inEffect).toBe(true);
  expect(body.settings.find((setting) => setting.key === "lanAccess")?.pending).toBe(true);
});

test("Memory settings apply to the governor without a restart", async () => {
  const response = await app.request("/stack/v1/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelBudgetBytes: 2_147_483_648 }) });
  expect(response.status).toBe(200);
  expect(getGovernorStatus().capBytes).toBe(2_147_483_648);
});

test("LAN access asks for the operator password before writing a pending setting", async () => {
  const response = await app.request("/stack/v1/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ lanAccess: true }) });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "Set the operator password before opening the Stack to the LAN.", setPasswordFirst: true });
  const current = await app.request("/stack/v1/settings");
  expect((await current.json() as { settings: Array<{ key: string; pending: unknown }> }).settings.find((setting) => setting.key === "lanAccess")?.pending).toBeNull();
});
