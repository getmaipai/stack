// ADMIN-05: the profile planner is pure and deterministic. Golden plans at 16, 24, 32, 48, 64, 96 and 128 GB with an injected hardware probe;
// the numbers come from the pinned footprints (tiers.ts) and the governor's OS reserve and working margins.
import { expect, test } from "bun:test";
import { MATCH_CEILING_GB, planFor, recommend, UPGRADE_HEADROOM_BYTES } from "@/lib/profilePlanner";
import type { HardwareInfo } from "@/lib/hardware";
import type { ProfileId } from "@/lib/tiers";

const hw = (gb: number): HardwareInfo => ({ platform: "darwin", arch: "arm64", totalRamGb: gb, cpuCount: 8, isAppleSilicon: true, unifiedMemoryGb: gb, cudaDevices: [], freeDiskBytes: 1e12, osVersion: "test" });
const summary = (gb: number): string => {
  const plan = recommend({ hardware: hw(gb) }).custom_recommended!.plan;
  return plan.roles.filter((r) => r.state !== "unavailable" || r.fit === "refused").map((r) => `${r.role}:${r.state}:${r.fit}${r.slot ? `:${r.slot}` : ""}${r.model && ["image", "video", "music"].includes(r.role) ? `=${r.model}` : ""}`).sort().join(" ");
};

// 96 and 128 GB follow the owner's 128 GB lineup (2026-11-25): FLUX 3 Klein is the Boost picture model there (96 GB looks one profile up), the VoxCPM2 voice holds 0.5 GB more than Chatterbox, and the resident chat model at 128 GB is the 35B (23 GB).
const GOLDEN: Record<number, { matched: ProfileId | null; tier: ProfileId; residentGb: number; roomGb: number; tight: boolean; roles: string }> = {
  16: { matched: "p16", tier: "p16", residentGb: 8.8, roomGb: 0, tight: true, roles: "chat:resident:fits embed:on_demand:queues:standard image:unavailable:refused judge:shared:fits music:unavailable:refused router:shared:fits stt:resident:fits tts:resident:fits video:unavailable:refused wakeword:installed:fits" },
  24: { matched: "p16", tier: "p16", residentGb: 8.8, roomGb: 8.4, tight: false, roles: "chat:resident:fits embed:on_demand:fits:standard image:on_demand:fits:standard=minimax-h3-image judge:shared:fits music:unavailable:refused router:shared:fits stt:resident:fits tts:resident:fits video:unavailable:refused wakeword:installed:fits" },
  32: { matched: "p32", tier: "p32", residentGb: 15.2, roomGb: 10.6, tight: false, roles: "chat:resident:fits embed:resident:fits image:on_demand:fits:standard=minimax-h3-image judge:resident:fits music:unavailable:refused rerank:on_demand:fits:standard router:shared:fits stt:resident:fits tts:resident:fits video:unavailable:refused wakeword:installed:fits" },
  48: { matched: null, tier: "p32", residentGb: 15.2, roomGb: 27.7, tight: false, roles: "chat:resident:fits embed:resident:fits image:on_demand:fits:boost=minimax-h3-image judge:resident:fits music:on_demand:fits:standard=ace-step-1-5-turbo rerank:on_demand:fits:standard router:shared:fits stt:resident:fits tts:resident:fits video:unavailable:refused wakeword:installed:fits" },
  64: { matched: "p64", tier: "p64", residentGb: 20.1, roomGb: 35.8, tight: false, roles: "chat:resident:fits coding:on_demand:fits:standard embed:resident:fits image:on_demand:fits:boost=minimax-h3-image judge:resident:fits music:on_demand:fits:standard=ace-step-1-5-turbo rerank:resident:fits router:shared:fits stt:resident:fits tts:resident:fits video:on_demand:fits:boost=ltx-2-5-q8-distilled-mlx wakeword:installed:fits" },
  96: { matched: null, tier: "p64", residentGb: 20.1, roomGb: 70.1, tight: false, roles: "chat:resident:fits coding:on_demand:fits:standard embed:resident:fits image:on_demand:fits:boost=flux3-image-klein judge:resident:fits music:on_demand:fits:standard=ace-step-1-5-turbo rerank:resident:fits router:shared:fits stt:resident:fits tts:resident:fits video:on_demand:fits:boost=ltx-2-5-q8-distilled-mlx wakeword:installed:fits" },
  128: { matched: "p128", tier: "p128", residentGb: 36.6, roomGb: 79.4, tight: false, roles: "chat:resident:fits coding:on_demand:fits:standard embed:resident:fits image:on_demand:fits:boost=flux3-image-klein judge:resident:fits music:on_demand:fits:standard=ace-step-1-5-turbo rerank:resident:fits router:shared:fits stt:resident:fits tts:resident:fits video:on_demand:fits:boost=ltx-2-5-q8-distilled-mlx vision:on_demand:fits:standard wakeword:installed:fits" },
};

for (const [size, golden] of Object.entries(GOLDEN)) {
  test(`golden plan at ${size} GB`, () => {
    const result = recommend({ hardware: hw(Number(size)) });
    expect(result.matched?.tier ?? null).toBe(golden.matched);
    const plan = result.custom_recommended!.plan;
    expect(plan.tier).toBe(golden.tier);
    expect(Math.round(plan.budget.resident_bytes / 1e8) / 10).toBe(golden.residentGb);
    expect(Math.round(plan.budget.room_bytes / 1e8) / 10).toBe(golden.roomGb);
    expect(plan.budget.tight).toBe(golden.tight);
    expect(summary(Number(size))).toBe(golden.roles);
  });
}

test("the same inputs give the same plan", () => {
  for (const gb of [16, 48, 128]) expect(JSON.stringify(recommend({ hardware: hw(gb) }))).toBe(JSON.stringify(recommend({ hardware: hw(gb) })));
});

test("matched is a tier within 25 percent above its floor (p16 up to 24 GB); 48 and 96 GB match nothing well", () => {
  const matched = (gb: number) => recommend({ hardware: hw(gb) }).matched?.tier ?? null;
  expect([16, 24, 25, 32, 40, 41, 48, 64, 80, 81, 96, 128, 160, 161].map(matched)).toEqual(["p16", "p16", null, "p32", "p32", null, null, "p64", "p64", null, null, "p128", "p128", null]);
  expect(MATCH_CEILING_GB.p32).toBe(32 * 1.25);
  expect(recommend({ hardware: hw(48) }).matched).toBeNull();
  expect(recommend({ hardware: hw(32) }).matched?.reason).toContain("within 25 percent");
});

test("a computer below 16 GB clears no tier: no plan, no match, the templates say none cleared", () => {
  const result = recommend({ hardware: hw(8) });
  expect(result.matched).toBeNull();
  expect(result.custom_recommended).toBeNull();
  expect(result.templates.every((row) => !row.cleared)).toBe(true);
});

test("a 48 GB computer gets more than the 32 GB template: a music slot and a boost picture slot", () => {
  const plan = recommend({ hardware: hw(48) }).custom_recommended!.plan;
  const slot = (role: string) => plan.roles.find((r) => r.role === role)!;
  expect(slot("music")).toMatchObject({ state: "on_demand", fit: "fits" });
  expect(slot("image").slot).toBe("boost");
  const template = planFor({ hardware: hw(32) })!;
  expect(template.roles.find((r) => r.role === "music")!.state).toBe("unavailable");
});

test("a role the person turned off is off, frees its memory and is not planned", () => {
  const plan = planFor({ hardware: hw(64), disabled: ["tts", "music"] })!;
  expect(plan.roles.find((r) => r.role === "tts")).toMatchObject({ state: "off", enabled: false });
  expect(plan.roles.find((r) => r.role === "music")).toMatchObject({ state: "off", fit: "n/a" });
  expect(plan.budget.resident_bytes).toBeLessThan(planFor({ hardware: hw(64) })!.budget.resident_bytes);
});

test("the plan lists roles by priority, ties by the declared order", () => {
  const plan = planFor({ hardware: hw(64), priority: { music: 1, image: 2 } })!;
  expect(plan.roles.slice(0, 2).map((r) => r.role)).toEqual(["music", "image"]);
  expect(plan.roles[2]!.role).toBe("chat");
});

test("a measured peak replaces the pinned estimate and its basis says measured", () => {
  const base = planFor({ hardware: hw(32) })!.roles.find((r) => r.role === "chat")!;
  expect(base.basis).toBe("estimated");
  const seen = planFor({ hardware: hw(32), measuredPeaks: { "qwen3-8b-instruct-q4-k-m": 6_000_000_000 } })!.roles.find((r) => r.role === "chat")!;
  expect(seen).toMatchObject({ basis: "measured", peak_bytes: 6_000_000_000 });
});

const GB = 1_000_000_000;
test("a chat upgrade is taken while it leaves headroom and every generator slot", () => {
  // Above the 35B (23 GB), the 128 GB Standard chat model since the owner's lineup of 2026-11-25.
  const plan = planFor({ hardware: hw(128), chatLadder: [{ id: "bigger-chat", peakBytes: 30 * GB, verified: false }] })!;
  expect(plan.chat_model).toBe("bigger-chat");
  expect(plan.roles.find((r) => r.role === "chat")).toMatchObject({ model: "bigger-chat", basis: "estimated" });
  expect(plan.budget.room_bytes).toBeGreaterThanOrEqual(UPGRADE_HEADROOM_BYTES);
});

test("a chat upgrade is refused when it would take the room a picture, video or music slot needs", () => {
  const plan = planFor({ hardware: hw(64), chatLadder: [{ id: "bigger-chat", peakBytes: 40 * GB, verified: false }] })!;
  expect(plan.chat_model).toBe("qwen3-8b-instruct-q4-k-m");
  expect(plan.roles.find((r) => r.role === "music")!.state).toBe("on_demand");
});

test("a picture role ranked above chat keeps its room: no upgrade, and the plan says why", () => {
  const ladder = [{ id: "bigger-chat", peakBytes: 30 * GB, verified: false }];
  expect(planFor({ hardware: hw(128), chatLadder: ladder, priority: { image: 1 } })!.chat_model).toBe("qwen3-6-35b-a3b-huihui-abliterated-q4-k-m");
  expect(planFor({ hardware: hw(128), chatLadder: ladder, priority: { image: 1 } })!.notes[0]).toContain("ranked above it");
});

test("the fit check (upgrade off) never changes the chat model", () => {
  const plan = planFor({ hardware: hw(128), chatLadder: [{ id: "bigger-chat", peakBytes: 30 * GB, verified: false }] }, { upgrade: false })!;
  expect(plan.chat_model).toBe("qwen3-6-35b-a3b-huihui-abliterated-q4-k-m");
});

test("the uncensored chat pin is never on the automatic ladder", async () => {
  const { defaultChatLadder } = await import("@/lib/profilePlanner");
  expect(defaultChatLadder("p128").map((r) => r.id)).not.toContain("qwen3-6-35b-a3b-huihui-abliterated-q4-k-m");
});

test("every role reason is a plain sentence and the why list names the budget", () => {
  const result = recommend({ hardware: hw(48) });
  for (const role of result.custom_recommended!.plan.roles) expect(role.reason.length).toBeGreaterThan(0);
  expect(result.custom_recommended!.why[0]).toContain("48 GB");
  expect(result.custom_recommended!.why.join(" ")).not.toContain(String.fromCharCode(0x2014));
});
