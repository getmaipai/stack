import { describe, expect, test } from "bun:test";
import { app } from "@/app";
import { listVoices } from "@/speech/voiceList";
import { POCKET_TTS_PRESET_VOICES } from "@/speech/voices";
import { Voice } from "@/spec/ts/voice";

describe("GET /stack/v1/voices (STACK-101a)", () => {
  test("returns 200 with a Voice-shaped list", async () => {
    const response = await app.request("/stack/v1/voices");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { voices: unknown[] };
    expect(body.voices.length).toBeGreaterThan(0);
    for (const entry of body.voices) {
      expect(Voice.safeParse(entry)).not.toHaveProperty("error");
    }
  });

  test("every preset voice is present with onDisk from the store", () => {
    const voices = listVoices();
    expect(voices.length).toBe(Object.keys(POCKET_TTS_PRESET_VOICES).length);
    for (const voice of voices) {
      expect(voice.source).toBe("preset");
      expect(typeof voice.onDisk).toBe("boolean");
    }
  });

  test("unknown metadata reads as unknown, never dropped", () => {
    const voices = listVoices();
    for (const voice of voices) {
      expect(voice.description).toBe("unknown");
      expect(voice.country).toBe("unknown");
      expect(voice.gender).toBe("unknown");
    }
  });
});
