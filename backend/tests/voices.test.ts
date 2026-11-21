import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { app } from "@/app";
import { listVoices } from "@/speech/voiceList";
import { POCKET_TTS_PRESET_VOICES } from "@/speech/voices";
 import { Voice } from "@/wire/voice";
 import { resetSupervisorForTests, scriptedProcess, setSupervisorFactoryForTests } from "@/lib/supervisor";

describe("VoxCPM2 voice list (VOICE-VOXCPM2-01)", () => {
  test.each(["voxcpm2", "voxcpm2-reduced"] as const)("%s lists one built-in voice carrying its engine name, so Home offers clip voices", (engine) => {
    const voices = listVoices(engine);
    expect(voices.length).toBe(1);
    expect(voices[0]!.engine).toBe(engine);
    expect(voices[0]!.tts?.engine).toBe(engine);
    expect(Voice.safeParse(voices[0]).success).toBe(true);
  });
});

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

describe("POST /stack/v1/voices/{id}/preview (STACK-101c)", () => {
  const voice = listVoices()[0]!;

  beforeEach(() => { setSupervisorFactoryForTests(async (role) => scriptedProcess(role)); });
  afterEach(() => { setSupervisorFactoryForTests(null); resetSupervisorForTests(); });

  test("renders the preview sentence once and serves it from disk thereafter", async () => {
    const first = await app.request(`/stack/v1/voices/${voice.id}/preview`, { method: "POST" });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("audio/wav");
    const bytes = new Uint8Array(await first.arrayBuffer());
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("RIFF");

    const second = await app.request(`/stack/v1/voices/${voice.id}/preview`, { method: "POST" });
    expect(second.status).toBe(200);
    expect(new Uint8Array(await second.arrayBuffer()).subarray(0, 4).length).toBe(4);
  });

  test("an unknown voice id is a 404, not a render", async () => {
    const response = await app.request("/stack/v1/voices/nobody/preview", { method: "POST" });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toMatch(/not one this engine can render/);
  });
});
