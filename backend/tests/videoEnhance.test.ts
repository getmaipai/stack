import { afterEach, expect, test } from "bun:test";
import { app } from "@/app";
import { ENHANCE_ADAPTER_PART, ENHANCE_NOT_INSTALLED_LINE, enhanceAdapterInstalled, EnhanceRefusal, setEnhanceInstalledForTests } from "@/video/enhance";

afterEach(() => setEnhanceInstalledForTests(null));
const post = (file?: File) => { const form = new FormData(); if (file) form.set("source_video", file); return app.request("/v1/videos/enhance", { method: "POST", body: form }); };
const clip = () => new File(["video"], "clip.mp4", { type: "video/mp4" });

test("no enhance adapter is pinned, so it is not installed", () => { expect(ENHANCE_ADAPTER_PART).toBeNull(); expect(enhanceAdapterInstalled()).toBe(false); });

test("enhance refuses not_installed with one plain line and the spec's refusal shape, and runs nothing", async () => {
  const res = await post(clip());
  expect(res.status).toBe(409);
  const body = await res.json() as { line: string };
  expect(EnhanceRefusal.parse(body)).toEqual({ code: "not_installed", line: ENHANCE_NOT_INSTALLED_LINE });
  expect(body.line).not.toMatch(/adapter|model|GB|memory|pin/i);
});

test("a missing or non-MP4 clip is a plain 422 before any refusal", async () => {
  expect(await (await post()).json()).toMatchObject({ error: "Send the clip to refine as source_video." });
  const bad = await post(new File(["x"], "clip.txt", { type: "text/plain" }));
  expect(bad.status).toBe(422);
});

test("even when an adapter reports installed, this build does not pretend to run it", async () => {
  setEnhanceInstalledForTests(() => true);
  expect((await post(clip())).status).toBe(503);
});
