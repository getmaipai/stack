// ENGINE-IDLE-01: how long the video, picture and music workers stay loaded after their last job.
// Video is short (2 minutes) because its models are 40 GB and more; a second clip inside the window reuses the worker.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { __resetSettingsForTests, SETTINGS, updateSettings } from "@/settings";
import { engineIdleMs, ENGINE_IDLE_DEFAULT_MINUTES } from "@/lib/engineIdle";
import { app } from "@/app";

beforeEach(() => __resetSettingsForTests());
afterEach(() => { __resetSettingsForTests(); for (const name of ["VIDEO_IDLE_MS", "IMAGE_IDLE_MS", "MUSIC_IDLE_MS"]) delete process.env[name]; });

test("defaults: video 2 minutes, music 5, picture 10; each is a live setting an admin can change", () => {
  expect(ENGINE_IDLE_DEFAULT_MINUTES).toEqual({ video: 2, music: 5, image: 10 });
  expect(engineIdleMs("video")).toBe(120_000);
  expect(engineIdleMs("music")).toBe(300_000);
  expect(engineIdleMs("image")).toBe(600_000);
  for (const role of ["video", "music", "image"]) {
    const setting = SETTINGS.find((candidate) => candidate.key === `stack.engines.${role}.keep_warm_minutes`);
    expect(setting?.needs_restart).toBe(false);
  }
  updateSettings({ "stack.engines.video.keep_warm_minutes": 7 });
  expect(engineIdleMs("video")).toBe(7 * 60_000);
});

test("the environment variable still wins, for tests and scratch runs", () => {
  process.env.VIDEO_IDLE_MS = "30";
  expect(engineIdleMs("video")).toBe(30);
});

test("the video status route reports the idle exit the worker really uses", async () => {
  updateSettings({ "stack.engines.video.keep_warm_minutes": 3 });
  const body = (await (await app.request("/stack/v1/video")).json()) as { video: { worker: { idle_exit_seconds: number } } };
  expect(body.video.worker.idle_exit_seconds).toBe(180);
});
