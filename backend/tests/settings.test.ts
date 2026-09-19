import { afterEach, expect, test } from "bun:test";
import { app } from "@/app";
import { setUpdatesEnabled } from "@/updates/check";
import { __resetStackSettingsForTests } from "@/settings/stackKeys";
import { getGovernorStatus } from "@/lib/governor";
import { __resetOperatorForTests } from "@/lib/operator";
import { STACK_SETTING_SECTIONS } from "@/settings/stackKeys";
import { iconNames } from "../../frontend/src/kit/icons";

afterEach(() => { setUpdatesEnabled(false); __resetStackSettingsForTests(); __resetOperatorForTests(); });

test("every declared settings section icon is available to the frontend", () => {
  expect(STACK_SETTING_SECTIONS.map((section) => section.icon).every((icon) => iconNames.includes(icon as typeof iconNames[number]))).toBe(true);
});

test("Stack settings route serves grouped declarations and keeps LAN access pending until restart", async () => {
  const setup = await app.request("/stack/v1/operator/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test password" }) });
  const cookie = setup.headers.get("set-cookie")?.split(";")[0] ?? "";
  const response = await app.request("/stack/v1/settings", { headers: { cookie } });
  expect(response.status).toBe(200);
  const initial = await response.json() as { settings: Array<{ key: string; group?: string; pending: unknown }> };
  expect(initial.settings.map((setting) => setting.key)).toEqual(expect.arrayContaining(["stackName", "theme", "updatesEnabled", "lanAccess", "port", "historyRetention", "logLevel", "modelBudgetBytes"]));
  expect(initial.settings.every((setting) => setting.group)).toBe(true);
  const updated = await app.request("/stack/v1/settings", { method: "PUT", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ updatesEnabled: true, lanAccess: true }) });
  expect(updated.status).toBe(200);
  const body = await updated.json() as { settings: Array<{ key: string; inEffect: unknown; pending: unknown }> };
  expect(body.settings.find((setting) => setting.key === "updatesEnabled")?.inEffect).toBe(true);
  expect(body.settings.find((setting) => setting.key === "lanAccess")?.pending).toBe(true);
});

test("Memory settings apply to the governor without a restart", async () => {
  const setup = await app.request("/stack/v1/operator/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test password" }) });
  const cookie = setup.headers.get("set-cookie")?.split(";")[0] ?? "";
  const response = await app.request("/stack/v1/settings", { method: "PUT", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ modelBudgetBytes: 2_147_483_648 }) });
  expect(response.status).toBe(200);
  expect(getGovernorStatus().capBytes).toBe(2_147_483_648);
});

test("settings route requires a signed-in session", async () => {
  const response = await app.request("/stack/v1/settings");
  expect(response.status).toBe(401);
});
