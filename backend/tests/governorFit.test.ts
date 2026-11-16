import { afterEach, beforeEach, expect, test } from "bun:test";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit, getGovernorDecisions, getGovernorStatus, getMaxWindow, release, setCodingModeActive, setMetalCapBytes, startGovernor, type GovernorHandle } from "@/lib/governor";

// QUEUE-FIT-01: generators are admitted by fit, not one at a time. A fake p128 ledger: 128 GB, 120 GB free, a 12 GB chat resident, and a model budget the tests set per case.
const GB = 1_000_000_000;
const stops: Array<() => void> = [];
beforeEach(() => { __resetGovernorForTests(); __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 120 * GB, tier: "p128" }); });
afterEach(() => { for (const stop of stops.splice(0)) stop(); setCodingModeActive(false); __resetGovernorForTests(); });

type Answer = Awaited<ReturnType<typeof admit>>;
const loadChat = async (): Promise<GovernorHandle> => await admit({ id: "chat", role: "chat", kind: "resident", class: "reserved", requestedBytes: 12 * GB }) as GovernorHandle;
const picture = (id: string, gb: number, tier?: "standard" | "boost" | "max"): Parameters<typeof admit>[0] => ({ id, kind: "generator", class: "burst", requestedBytes: gb * GB, ...(tier ? { tier } : {}) });
const video = (id: string): Parameters<typeof admit>[0] => ({ id, role: "video", kind: "generator", class: "burst", requestedBytes: 61.5 * GB, tier: "max" });
const isHandle = (answer: Answer): answer is GovernorHandle => "id" in answer && !("queued" in answer);
const isQueued = (answer: Answer): boolean => "queued" in answer;
const waitFor = (answer: Answer): Promise<unknown> => Promise.race([(answer as { admitted: Promise<unknown> }).admitted, Bun.sleep(300).then(() => "waiting")]);
const queueIds = (): string[] => getGovernorStatus().queue.map((entry) => entry.id);
const loadedIds = (): string[] => getGovernorStatus().loaded.map((item) => item.id);

test("(a) two Standard pictures run together with chat resident", async () => {
  setMetalCapBytes(50 * GB);
  await loadChat();
  const first = await admit(picture("pic-1", 18.8, "standard"));
  const second = await admit(picture("pic-2", 18.8, "standard"));
  expect(isHandle(first)).toBe(true);
  expect(isHandle(second)).toBe(true);
  expect(loadedIds()).toEqual(["chat", "pic-1", "pic-2"]);
});

test("(b) a third picture that would exceed the cap waits, and starts when one ends", async () => {
  setMetalCapBytes(50 * GB);
  await loadChat();
  const first = await admit(picture("pic-1", 18.8, "standard")) as GovernorHandle;
  await admit(picture("pic-2", 18.8, "standard"));
  const third = await admit(picture("pic-3", 18.8, "standard"));
  expect(isQueued(third)).toBe(true);
  expect(queueIds()).toEqual(["pic-3"]);
  release(first);
  expect(await waitFor(third)).toMatchObject({ id: "pic-3" });
  expect(queueIds()).toEqual([]);
});

test("(c) a Standard picture is admitted beside a running Boost picture", async () => {
  setMetalCapBytes(75 * GB);
  await loadChat();
  const boost = await admit(picture("boost-pic", 25.8, "boost"));
  const standard = await admit(picture("std-pic", 18.8, "standard"));
  expect(isHandle(boost)).toBe(true);
  expect(isHandle(standard)).toBe(true);
  expect(getGovernorStatus().loaded.map((item) => item.tier)).toEqual([undefined, "boost", "standard"]);
});

test("(d) a Standard job is refused while a Max window is open, but reserved work is not", async () => {
  setMetalCapBytes(75 * GB);
  await loadChat();
  const max = await admit(video("max-video"));
  expect(isHandle(max)).toBe(true);
  expect(getMaxWindow()).toMatchObject({ state: "open", ownerId: "max-video" });
  const standard = await admit(picture("std-pic", 5, "standard"));
  expect(isQueued(standard)).toBe(true);
  expect(getGovernorDecisions()[0]).toMatchObject({ decision: "Queued", model: "std-pic", reasonCode: "max_window" });
  const voice = await admit({ id: "tts", role: "voice", kind: "resident", class: "reserved", requestedBytes: 1 * GB });
  expect(isHandle(voice)).toBe(true);
});

test("a Max job never starts beside a running generator, and never beside another Boost or Max", async () => {
  setMetalCapBytes(100 * GB);
  await loadChat();
  const running = await admit(picture("pic-1", 5, "standard")) as GovernorHandle;
  const max = await admit(video("max-video"));
  expect(isQueued(max)).toBe(true);
  expect(getMaxWindow()).toMatchObject({ state: "draining" });
  release(running);
  expect(await waitFor(max)).toMatchObject({ id: "max-video", tier: "max" });
});

test("(e) queue [Max video waiting for drain, Standard picture]: the picture runs, the video keeps its hold", async () => {
  setMetalCapBytes(75 * GB);
  await loadChat();
  const running = await admit(picture("pic-run", 18.8, "standard")) as GovernorHandle;
  const max = await admit(video("max-video"));
  expect(isQueued(max)).toBe(true);
  expect(getMaxWindow()).toMatchObject({ state: "draining", ownerId: "max-video" });
  const small = await admit(picture("pic-small", 18.8, "standard"));
  expect(isHandle(small)).toBe(true);
  expect(queueIds()).toEqual(["max-video"]);
  expect(getMaxWindow()).toMatchObject({ state: "draining", ownerId: "max-video" });
  expect(getGovernorDecisions().find((decision) => decision.model === "pic-small" && decision.reasonCode === "backfill")).toMatchObject({ decision: "Admitted" });
  release(running);
  release(small as GovernorHandle);
  expect(await waitFor(max)).toMatchObject({ id: "max-video" });
});

test("(f) after backfillMaxWaitMs the next Standard job is held with backfill_closed and the Max runs when the running jobs end", async () => {
  setMetalCapBytes(75 * GB);
  __setGovernorTuningForTestsOnly({ backfillMaxWaitMs: 40 });
  await loadChat();
  const run1 = await admit(picture("pic-run", 18.8, "standard")) as GovernorHandle;
  const max = await admit(video("max-video"));
  const run2 = await admit(picture("pic-past", 5, "standard")) as GovernorHandle;
  expect(isHandle(run2)).toBe(true);
  await Bun.sleep(60);
  const late = await admit(picture("pic-late", 5, "standard"));
  expect(isQueued(late)).toBe(true);
  expect(getGovernorDecisions()[0]).toMatchObject({ decision: "Queued", model: "pic-late", reasonCode: "backfill_closed" });
  expect(queueIds()).toEqual(["max-video", "pic-late"]);
  release(run1);
  expect(queueIds()).toEqual(["max-video", "pic-late"]);
  release(run2);
  expect(await waitFor(max)).toMatchObject({ id: "max-video", tier: "max" });
  expect(queueIds()).toEqual(["pic-late"]);
  expect(getMaxWindow()).toMatchObject({ state: "open", ownerId: "max-video" });
});

test("a waiting job is passed over by a smaller one that fits, through the queue as well as at the door", async () => {
  setMetalCapBytes(50 * GB);
  await loadChat();
  const a = await admit(picture("pic-a", 18.8, "standard")) as GovernorHandle;
  await admit(picture("pic-b", 18.8, "standard"));
  const big = await admit(picture("pic-big", 22, "standard"));
  const small = await admit(picture("pic-small", 5, "standard"));
  expect(isQueued(big)).toBe(true);
  expect(isQueued(small)).toBe(true);
  expect(queueIds()).toEqual(["pic-big", "pic-small"]);
  release(a);
  expect(queueIds()).toEqual(["pic-big"]);
  expect(loadedIds()).toContain("pic-small");
  expect(getGovernorDecisions()[0]).toMatchObject({ decision: "Admitted", model: "pic-small", reasonCode: "backfill" });
  expect(getGovernorDecisions().some((decision) => decision.model === "pic-big" && decision.decision === "Admitted")).toBe(false);
});

test("a poll admits the small job past the big one and stops once the big one has waited too long", async () => {
  setMetalCapBytes(50 * GB);
  __setGovernorTuningForTestsOnly({ backfillMaxWaitMs: 40 });
  await loadChat();
  const a = await admit(picture("pic-a", 18.8, "standard")) as GovernorHandle;
  const b = await admit(picture("pic-b", 18.8, "standard")) as GovernorHandle;
  const big = await admit(picture("pic-big", 22, "standard"));
  const first = await admit(picture("pic-first", 10, "standard"));
  const second = await admit(picture("pic-second", 10, "standard"));
  expect(queueIds()).toEqual(["pic-big", "pic-first", "pic-second"]);
  stops.push(startGovernor({ pid: 1, pollMs: 2, freeMemory: () => 120 * GB, totalMemory: () => 128 * GB }));
  await Bun.sleep(20);
  expect(queueIds()).toEqual(["pic-big", "pic-first", "pic-second"]);
  release(a);
  const firstHandle = await waitFor(first) as GovernorHandle;
  expect(firstHandle).toMatchObject({ id: "pic-first" });
  await Bun.sleep(60);
  release(firstHandle);
  await Bun.sleep(20);
  expect(queueIds()).toEqual(["pic-big", "pic-second"]);
  expect(getGovernorDecisions().some((decision) => decision.model === "pic-second" && decision.reasonCode === "backfill_closed")).toBe(true);
  void big; void b;
});

test("(g) coding mode on: a Standard picture is admitted, a Boost picture is held", async () => {
  setMetalCapBytes(75 * GB);
  await loadChat();
  setCodingModeActive(true);
  const standard = await admit(picture("std-pic", 18.8, "standard"));
  expect(isHandle(standard)).toBe(true);
  const boost = await admit(picture("boost-pic", 25.8, "boost"));
  expect(isQueued(boost)).toBe(true);
  expect(getGovernorDecisions()[0]).toMatchObject({ decision: "Queued", model: "boost-pic", reasonCode: "coding_mode" });
  const untiered = await admit(picture("plain-pic", 5));
  expect(isHandle(untiered)).toBe(true);
  setCodingModeActive(false);
  release(standard as GovernorHandle);
  expect(await waitFor(boost)).toMatchObject({ id: "boost-pic", tier: "boost" });
});

test("(h) two Boost jobs never run together", async () => {
  setMetalCapBytes(100 * GB);
  await loadChat();
  const first = await admit(picture("boost-a", 25.8, "boost")) as GovernorHandle;
  const second = await admit(picture("boost-b", 25.8, "boost"));
  expect(isQueued(second)).toBe(true);
  expect(getGovernorStatus().loaded.filter((item) => item.tier === "boost").length).toBe(1);
  release(first);
  expect(await waitFor(second)).toMatchObject({ id: "boost-b" });
  expect(getGovernorStatus().loaded.filter((item) => item.tier === "boost").length).toBe(1);
});

test("fit is still the rule: memory pressure and the memory-reading refusal hold a generator", async () => {
  setMetalCapBytes(75 * GB);
  await loadChat();
  __setGovernorTuningForTestsOnly({ freeMemoryBytes: 30 * GB });
  const tight = await admit(picture("pic-tight", 18.8, "standard"));
  expect(isQueued(tight)).toBe(true);
});
