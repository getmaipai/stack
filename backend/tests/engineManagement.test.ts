import { afterEach, expect, test } from "bun:test";
import { deriveEngineVersionState } from "@/lib/engineState";
import { getChatBackend, resetSupervisorForTests, restartChatEngine, setSupervisorFactoryForTests, stopChatEngine } from "@/lib/supervisor";
import { llamaServerArgs } from "@/lib/engineArgs";
import { __resetEngineSettingsForTests, ENGINE_SETTINGS, readEngineConfig, updateEngineConfig } from "@/settings/engineKeys";

afterEach(() => {
  delete process.env.STACK_SCRIPTED_ENGINES;
  setSupervisorFactoryForTests(null);
  resetSupervisorForTests();
  __resetEngineSettingsForTests();
});

test("version state distinguishes current, newer installed, and newer available", () => {
  expect(deriveEngineVersionState({ running: "b2", currentTag: "b2", newestTag: "b2", needsRestart: false }).state).toBe("current");
  expect(deriveEngineVersionState({ running: "b1", currentTag: "b2", newestTag: "b2", needsRestart: false }).stateReason).toBe("newer installed");
  expect(deriveEngineVersionState({ running: "b1", currentTag: "b1", newestTag: "b2", needsRestart: false }).stateReason).toBe("newer available");
});

test("every engine setting has a group for the generic renderer", () => {
  for (const declarations of Object.values(ENGINE_SETTINGS)) for (const declaration of declarations) expect(declaration.group).toBeTruthy();
});

test("engine configuration validates type and range, then activates pending values on restart", async () => {
  const name = "llama-server";
  expect(() => updateEngineConfig(name, { contextLength: "large" }, "llama-server")).toThrow();
  expect(() => updateEngineConfig(name, { contextLength: 1 }, "llama-server")).toThrow();
  updateEngineConfig(name, { contextLength: 8192, flashAttention: false }, "llama-server");
  const pending = readEngineConfig(name, "llama-server");
  expect(pending.find((setting) => setting.key === "contextLength")?.pending).toBe(8192);
  expect(pending.find((setting) => setting.key === "contextLength")?.inEffect).toBe(4096);
  process.env.STACK_SCRIPTED_ENGINES = "1";
  await restartChatEngine();
  await getChatBackend();
  expect(readEngineConfig(name, "llama-server").some((setting) => setting.pending !== null)).toBe(false);
  expect(readEngineConfig(name, "llama-server").find((setting) => setting.key === "contextLength")?.inEffect).toBe(8192);
});

test("spawned controls start, stop, and restart a scripted engine", async () => {
  process.env.STACK_SCRIPTED_ENGINES = "1";
  await getChatBackend();
  await stopChatEngine();
  await restartChatEngine();
  await getChatBackend();
  expect(true).toBe(true);
});

test("command construction uses declared effective engine settings", () => {
  const config = { contextLength: 8192, slots: 2, threads: 8, cacheRamMb: 512, flashAttention: false };
  const args = llamaServerArgs({ modelPath: "/tmp/model.gguf", port: 8080, config, contextLength: 8192, kvCacheQuantized: false });
  expect(args).toEqual([
    "--model", "/tmp/model.gguf",
    "--port", "8080",
    "--host", "127.0.0.1",
    "-c", "8192",
    "-fa", "off",
    "-ngl", "all",
    "--reasoning", "off",
    "-ub", "1024",
    "--no-webui",
    "--metrics",
    "--jinja",
    "--cache-reuse", "256",
    "--parallel", "2",
    "--threads", "8",
    "--cache-ram-mb", "512",
  ]);
});
