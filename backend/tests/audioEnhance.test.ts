import { describe, expect, test } from "bun:test";
import { app } from "@/app";

describe("POST /v1/audio/enhance", () => {
  test("rejects a non-WAV body without starting the worker", async () => {
    const response = await app.request("/v1/audio/enhance", { method: "POST", headers: { "content-type": "audio/wav" }, body: "not a wav" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("not a WAV");
  });

  test("rejects clips larger than 20 MB", async () => {
    const response = await app.request("/v1/audio/enhance", { method: "POST", headers: { "content-type": "audio/wav" }, body: new Uint8Array(20 * 1024 * 1024 + 1) });
    expect(response.status).toBe(413);
  });

  test("says plainly that the model is not installed", async () => {
    const wav = new Uint8Array(44 + 48000 * 2); wav.set([82, 73, 70, 70], 0); wav.set([87, 65, 86, 69], 8);
    const view = new DataView(wav.buffer); view.setUint32(24, 48000, true); view.setUint32(28, 96000, true);
    const response = await app.request("/v1/audio/enhance", { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe("not_installed");
  });
});
