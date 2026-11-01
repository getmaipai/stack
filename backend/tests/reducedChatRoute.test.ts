// TIER-REDUCED-ROUTE: POST /stack/v1/tiers/reduced with the supervisor stubbed, the state in /memory, and the safety cap.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { resetReducedChatForTests, setReducedChatState } from "@/lib/reducedChat";
import { __setReducedLeaseForTests } from "@/lib/reducedChatLease";

type Swap = { ok: true; swapMs: number } | { ok: false; waiting: true } | { ok: false; reason: string };
let enterResult: Swap; let leaveResult: Swap; let calls: string[];
const stubs = () => ({
  enter: async () => { calls.push("enter"); if (enterResult.ok) setReducedChatState("reduced"); return enterResult; },
  leave: async () => { calls.push("leave"); if (leaveResult.ok) setReducedChatState("off"); return leaveResult; },
});
beforeEach(() => { calls = []; enterResult = { ok: true, swapMs: 1200 }; leaveResult = { ok: true, swapMs: 900 }; resetReducedChatForTests(); __setReducedLeaseForTests({ deps: stubs() }); });
afterEach(() => { __setReducedLeaseForTests(null); resetReducedChatForTests(); });

const post = (body: unknown) => app.request("/stack/v1/tiers/reduced", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const reducedInMemory = async () => (await (await app.request("/stack/v1/memory")).json() as { reduced_chat: boolean }).reduced_chat;

test("on:true enters Reduced, 200 with the swap time, and /memory reports it", async () => {
  expect(await reducedInMemory()).toBe(false);
  const res = await post({ on: true });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, swap_ms: 1200, reduced: true });
  expect(await reducedInMemory()).toBe(true);
});

test("entering twice is idempotent: the second answer is 200 with swap_ms 0 and no second swap", async () => {
  await post({ on: true });
  const res = await post({ on: true });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, swap_ms: 0, reduced: true });
  expect(calls).toEqual(["enter"]);
});

test("on:false leaves Reduced, and leaving when already standard is 200 with swap_ms 0", async () => {
  await post({ on: true });
  const res = await post({ on: false });
  expect(await res.json()).toEqual({ ok: true, swap_ms: 900, reduced: false });
  expect(await reducedInMemory()).toBe(false);
  const again = await post({ on: false });
  expect(again.status).toBe(200);
  expect(await again.json()).toEqual({ ok: true, swap_ms: 0, reduced: false });
  expect(calls).toEqual(["enter", "leave"]);
});

test("a chat turn in flight answers 202 waiting and changes nothing", async () => {
  enterResult = { ok: false, waiting: true };
  const res = await post({ on: true });
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: false, waiting: true, reduced: false });
  expect(await reducedInMemory()).toBe(false);
});

test("a refusal is 409 and a failed swap is 503, each with a plain sentence and chat not Reduced", async () => {
  enterResult = { ok: false, reason: "Reduced chat is unavailable while coding mode is active." };
  const refused = await post({ on: true });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ ok: false, reason: "Reduced chat is unavailable while coding mode is active.", reduced: false });
  enterResult = { ok: false, reason: "Chat could not switch to the smaller model, so it stayed on the standard one." };
  const failed = await post({ on: true });
  expect(failed.status).toBe(503);
  expect(((await failed.json()) as { reduced: boolean }).reduced).toBe(false);
  expect(await reducedInMemory()).toBe(false);
});

test("a failed leave keeps reduced:true in the answer", async () => {
  await post({ on: true });
  leaveResult = { ok: false, reason: "Chat could not return to its standard model, so it stayed on the smaller one." };
  const res = await post({ on: false });
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ ok: false, reason: "Chat could not return to its standard model, so it stayed on the smaller one.", reduced: true });
});

test("a body without on is rejected", async () => {
  expect((await post({})).status).toBe(400);
});

test("with no renewal the Stack leaves Reduced after the cap, and a renewal restarts the clock", async () => {
  __setReducedLeaseForTests({ capMs: 80, retryMs: 20, deps: stubs() });
  await post({ on: true });
  await Bun.sleep(50);
  await post({ on: true }); // renew
  await Bun.sleep(50);
  expect(await reducedInMemory()).toBe(true); // 100 ms since entering, but only 50 since the renewal
  await Bun.sleep(100);
  expect(await reducedInMemory()).toBe(false);
  expect(calls).toEqual(["enter", "leave"]);
});

test("when a chat turn blocks the cap leave, it retries until the turn ends", async () => {
  let busy = true;
  __setReducedLeaseForTests({ capMs: 30, retryMs: 20, deps: { ...stubs(), leave: async () => { calls.push("leave"); if (busy) return { ok: false, waiting: true }; setReducedChatState("off"); return { ok: true, swapMs: 5 }; } } });
  await post({ on: true });
  await Bun.sleep(80);
  expect(await reducedInMemory()).toBe(true);
  busy = false;
  await Bun.sleep(60);
  expect(await reducedInMemory()).toBe(false);
});
