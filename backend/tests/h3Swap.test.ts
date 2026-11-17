import { expect, test } from "bun:test";
import { app } from "@/app";
import { h3SwapCommand, h3SwapSegmentCount, h3SwapReady, h3SwapMemory, H3_SWAP_MAX_SECONDS, useH3SwapDepsForTests } from "@/video/swap";

test("H3 swap segments use 56 frames, about 2.333 seconds, and at most five for ten seconds", () => {
  expect(h3SwapSegmentCount(2.333)).toBe(1); expect(h3SwapSegmentCount(7)).toBe(3); expect(h3SwapSegmentCount(10)).toBe(5); expect(h3SwapSegmentCount(2.34)).toBe(1); expect(h3SwapSegmentCount(2.5)).toBe(2); expect(H3_SWAP_MAX_SECONDS).toBe(10);
});

test("swap command carries description, guide, LoRA, model root and references", () => {
  const command = h3SwapCommand({ binary: "/mere.run", lora: "/swap.safetensors", models: "/models", width: 640, height: 480, frames: 56, guide: "/guide.mp4", output: "/out.mp4", references: ["/a.jpg", "/b.png", "/c.webp"], description: "curly hair, beard, olive skin" });
  expect(command.argv.slice(0, 4)).toEqual(["/mere.run", "video", "generate", expect.stringContaining("curly hair, beard, olive skin")]);
  expect(command.argv.filter((arg) => arg === "--reference")).toHaveLength(3); expect(command.argv).toContain("image:/a.jpg"); expect(command.argv).toContain("--h3-guide-video"); expect(command.argv).toContain("/swap.safetensors:1.0"); expect(command.env.MERERUN_MODELS_DIR).toBe("/models");
});

test("H3 swap readiness needs binary, LoRA and model root", () => {
  const names = ["MAIPAI_H3_SWAP_BIN", "MAIPAI_H3_SWAP_LORA", "MERERUN_MODELS_DIR"] as const; const before = names.map((name) => process.env[name]);
  try { for (const name of names) process.env[name] = "/nonexistent/swap-test"; expect(h3SwapReady()).toBe(false); }
  finally { names.forEach((name, index) => before[index] === undefined ? delete process.env[name] : process.env[name] = before[index]!); useH3SwapDepsForTests(null); }
});

test("swap admission declares the measured peak per size", () => {
  expect(h3SwapMemory({ size: "640x480" })).toMatchObject({ measuredPeakBytes: 112 * 1024 ** 3 }); expect(h3SwapMemory({ size: "512x384" })).toMatchObject({ measuredPeakBytes: 85 * 1024 ** 3 });
});

test("swap upload returns plain validation errors and allows a missing description", async () => {
  const src = new File(["video"], "clip.mp4", { type: "video/mp4" }); const req = async (refs: File[] = [], extra: Record<string, string> = {}) => { const form = new FormData(); form.set("source_video", src); refs.forEach((ref) => form.append("references", ref)); Object.entries(extra).forEach(([key, value]) => form.set(key, value)); return app.request("/v1/videos/swap", { method: "POST", body: form }); };
  expect(await (await req()).json()).toMatchObject({ error: "Send at least one reference picture (PNG, JPEG or WebP)." });
  expect(await (await req([new File(["x"], "bad.txt", { type: "text/plain" })])).json()).toMatchObject({ error: "A reference is not a picture. Send PNG, JPEG or WebP photos." });
  expect(await (await req([new File(["x"], "ok.jpg", { type: "image/jpeg" })], { seconds: "10.1" })).json()).toMatchObject({ error: "The window can be at most 10 seconds. It uses 5 segments of 56 frames (about 2.333 seconds each)." });
  expect(await (await req([new File(["x"], "ok.jpg", { type: "image/jpeg" })], { description: "" })).status).toBe(503);
  expect(await (await req([new File(["x"], "ok.jpg", { type: "image/jpeg" })], { source_video: "" })).status).toBe(422);
  const large = new File([new Uint8Array(60 * 1024 * 1024 + 1)], "large.mp4", { type: "video/mp4" }); const form = new FormData(); form.set("source_video", large); form.append("references", new File(["x"], "ok.jpg", { type: "image/jpeg" }));
  expect(await (await app.request("/v1/videos/swap", { method: "POST", body: form })).json()).toMatchObject({ error: "The source clip is larger than 60 MB. Choose a smaller MP4 clip." });
});

