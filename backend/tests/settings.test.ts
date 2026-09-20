import { beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetSettingsForTests, applyPendingSettings, engineSettingValues, readSettings, SETTINGS, settingValues, updateSettings } from "@/settings";
import { getGovernorStatus } from "@/lib/governor";

beforeEach(() => __resetSettingsForTests());

test("every setting is declared once, in the spec's StackSetting shape, with a section, a level and a default", () => {
  const keys = SETTINGS.map((setting) => setting.key);
  expect(new Set(keys).size).toBe(keys.length);
  for (const setting of readSettings()) {
    expect(["basic", "advanced", "expert"]).toContain(setting.level);
    expect(typeof setting.section?.id).toBe("string");
    expect(setting.default).not.toBeUndefined();
    expect(setting.lives_in).toBe("stack");
    expect(setting.key).toMatch(/^stack(\.[a-z][a-z0-9_]*)+$/);
  }
  expect(keys).toEqual(expect.arrayContaining(["stack.memory.model_budget_bytes", "stack.updates.enabled", "stack.runtime.port", "stack.engines.llama_server.context_length", "stack.engines.chat.host_url", "stack.engines.tts.host_url"]));
});

test("a live key applies at once and reaches the module that consumes it", () => {
  updateSettings({ "stack.memory.model_budget_bytes": 4 * 1_073_741_824 });
  expect(settingValues()["stack.memory.model_budget_bytes"]).toBe(4 * 1_073_741_824);
  expect(getGovernorStatus().capBytes).toBe(4 * 1_073_741_824);
});

test("a restart key stays pending until applied, and a value equal to the one in effect clears it", () => {
  updateSettings({ "stack.engines.llama_server.context_length": 8192 });
  const record = readSettings().find((setting) => setting.key === "stack.engines.llama_server.context_length")!;
  expect(record.in_effect).toBe(4096);
  expect(record.pending).toBe(8192);
  expect(engineSettingValues("engines.llama_server").context_length).toBe(4096);
  applyPendingSettings();
  expect(engineSettingValues("engines.llama_server").context_length).toBe(8192);
  updateSettings({ "stack.engines.llama_server.context_length": 8192 });
  expect(readSettings().find((setting) => setting.key === "stack.engines.llama_server.context_length")!.pending).toBeNull();
});

test("an unknown key or an out-of-range value is refused, and the route says so", async () => {
  expect(() => updateSettings({ theme: "dark" })).toThrow(/Unknown Stack setting/);
  expect(() => updateSettings({ "stack.runtime.port": 70_000 })).toThrow();
  const response = await app.request("/stack/v1/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ lanAccess: true }) });
  expect(response.status).toBe(400);
  const listed = await app.request("/stack/v1/settings");
  const body = await listed.json() as { sections: unknown[]; settings: Array<{ key: string; in_effect: unknown; pending: unknown }> };
  expect(body.sections.length).toBeGreaterThan(0);
  expect(body.settings.find((setting) => setting.key === "stack.updates.enabled")).toMatchObject({ in_effect: false, pending: null });
});

test("a value stored under a pre-spec key name is renamed once, never orphaned", async () => {
  const { db } = await import("@/db");
  const { meta } = await import("@/db/schema");
  const { migrateRenamedSettingKeys } = await import("@/settings");
  db.insert(meta).values({ key: "settings.engines.chat.hostUrl.inEffect", value: JSON.stringify("http://127.0.0.1:9999") }).run();
  db.insert(meta).values({ key: "settings.port.pending", value: "8790" }).run();
  expect(migrateRenamedSettingKeys()).toBe(2);
  expect(settingValues()["stack.engines.chat.host_url"]).toBe("http://127.0.0.1:9999");
  expect(readSettings().find((setting) => setting.key === "stack.runtime.port")!.pending).toBe(8790);
  expect(migrateRenamedSettingKeys()).toBe(0);
});
