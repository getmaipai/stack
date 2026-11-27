import { expect, test } from "bun:test";
import { plannedPinsFor } from "@/lib/installPlan";
import { PROFILE_TIERS } from "@/profiles";

const ids = (tier: string) => plannedPinsFor(PROFILE_TIERS.find((t) => t.id === tier)!).map((entry) => entry.pin.id);

test("the 128 GB preset is the owner's lineup and leaves the dropped parts out", () => {
  const plan = ids("p128");
  expect(plan[0]).toBe("qwen3-6-35b-a3b-huihui-abliterated-q4-k-m");
  expect(plan).toContain("voxcpm2-bf16");
  expect(plan).toContain("flux3-image-klein");
  for (const gone of ["qwen3-8b-instruct-q4-k-m", "chatterbox-turbo-fp16", "pocket-tts-english", "flux2-klein-4b"]) expect(plan).not.toContain(gone);
});

test("other tiers keep their preset", () => {
  expect(ids("p64")).toContain("chatterbox-turbo-fp16");
  expect(ids("p32")).toContain("qwen3-8b-instruct-q4-k-m");
});
