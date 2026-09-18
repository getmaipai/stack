import { afterEach, expect, test } from "bun:test";
import { app } from "@/app";
import { setUpdatesEnabled } from "@/updates/check";
import { __resetStackSettingsForTests } from "@/settings/stackKeys";

afterEach(() => { setUpdatesEnabled(false); __resetStackSettingsForTests(); });

test("Stack settings route serves grouped declarations and keeps LAN access pending until restart", async () => {
  const response = await app.request("/stack/v1/settings");
  expect(response.status).toBe(200);
  const initial = await response.json() as { settings: Array<{ key: string; group?: string; pending: unknown }> };
  expect(initial.settings.map((setting) => setting.key)).toEqual(["updatesEnabled", "lanAccess"]);
  expect(initial.settings.every((setting) => setting.group)).toBe(true);
  const updated = await app.request("/stack/v1/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ updatesEnabled: true, lanAccess: true }) });
  expect(updated.status).toBe(200);
  const body = await updated.json() as { settings: Array<{ key: string; inEffect: unknown; pending: unknown }> };
  expect(body.settings.find((setting) => setting.key === "updatesEnabled")?.inEffect).toBe(true);
  expect(body.settings.find((setting) => setting.key === "lanAccess")?.pending).toBe(true);
});
