import { beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetSettingsForTests, applyPendingSettings, engineSettingValues, readSettings, SETTINGS, settingValues, updateSettings } from "@/settings";
import { getGovernorStatus } from "@/lib/governor";

beforeEach(() => __resetSettingsForTests());

test("every setting is declared once with a section, a level and a default", () => {
  const keys = SETTINGS.map((setting) => setting.key);
  expect(new Set(keys).size).toBe(keys.length);
  for (const setting of SETTINGS) {
    expect(["basic", "advanced", "developer"]).toContain(setting.disclosure);
    expect(typeof setting.section).toBe("string");
    expect(setting.default).not.toBeUndefined();
  }
  expect(keys).toEqual(expect.arrayContaining(["modelBudgetBytes", "updatesEnabled", "port", "engines.llama-server.contextLength", "engines.chat.hostUrl", "engines.tts.hostUrl"]));
});

test("a live key applies at once and reaches the module that consumes it", () => {
  updateSettings({ modelBudgetBytes: 4 * 1_073_741_824 });
  expect(settingValues().modelBudgetBytes).toBe(4 * 1_073_741_824);
  expect(getGovernorStatus().capBytes).toBe(4 * 1_073_741_824);
});

test("a restart key stays pending until applied, and a value equal to the one in effect clears it", () => {
  updateSettings({ "engines.llama-server.contextLength": 8192 });
  const record = readSettings().find((setting) => setting.key === "engines.llama-server.contextLength")!;
  expect(record.inEffect).toBe(4096);
  expect(record.pending).toBe(8192);
  expect(engineSettingValues("engines.llama-server").contextLength).toBe(4096);
  applyPendingSettings();
  expect(engineSettingValues("engines.llama-server").contextLength).toBe(8192);
  updateSettings({ "engines.llama-server.contextLength": 8192 });
  expect(readSettings().find((setting) => setting.key === "engines.llama-server.contextLength")!.pending).toBeNull();
});

test("an unknown key or an out-of-range value is refused, and the route says so", async () => {
  expect(() => updateSettings({ theme: "dark" })).toThrow(/Unknown Stack setting/);
  expect(() => updateSettings({ port: 70_000 })).toThrow();
  const response = await app.request("/stack/v1/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ lanAccess: true }) });
  expect(response.status).toBe(400);
  const listed = await app.request("/stack/v1/settings");
  const body = await listed.json() as { sections: unknown[]; settings: Array<{ key: string; inEffect: unknown; pending: unknown }> };
  expect(body.sections.length).toBeGreaterThan(0);
  expect(body.settings.find((setting) => setting.key === "updatesEnabled")).toMatchObject({ inEffect: false, pending: null });
});
