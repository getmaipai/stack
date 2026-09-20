import { afterEach, expect, test } from "bun:test";
import { setUpdatesEnabled, check } from "@/updates/check";
import { recommendationsFor, watchModels } from "@/updates/models";
import { __resetEventsForTests, listNotifications } from "@/lib/events";

afterEach(() => setUpdatesEnabled(false));

test("conditional update checks send only the required headers and keep 304 state", async () => {
  setUpdatesEnabled(true);
  const requests: Request[] = [];
  const first = await check("app", async (input, init) => { requests.push(new Request(input as string, init)); return new Response(JSON.stringify({ version: "0.2.0", notes: "New", pub_date: "2026-09-17", platforms: { default: { url: "https://example.test/app", sha256: "a".repeat(64), size: 42, signature: "sig" } } }), { headers: { etag: "etag-1" } }); });
  expect(first.available).toBe("0.2.0");
  expect(new URL(requests[0]!.url).search).toBe("");
  expect([...requests[0]!.headers.keys()].sort()).toEqual(["if-none-match", "user-agent"]);
  const second = await check("app", async (_input, init) => { requests.push(new Request("https://example.test/app", init)); return new Response(null, { status: 304 }); });
  expect(second.available).toBe("0.2.0");
  expect(requests[1]!.headers.get("if-none-match")).toBe("etag-1");
});

test("a genuinely new available update emits update.available once, not on every repeat check", async () => {
  __resetEventsForTests();
  setUpdatesEnabled(true);
  const manifest = () => new Response(JSON.stringify({ version: "9.9.9", notes: "New", pub_date: "2026-09-17", platforms: { default: { url: "https://example.test/engines", sha256: "a".repeat(64), size: 42, signature: "sig" } } }));
  const first = await check("engines", async () => manifest());
  expect(first.available).toBe("9.9.9");
  const second = await check("engines", async () => manifest());
  expect(second.available).toBe("9.9.9");
  const updateNotifications = (listNotifications() as Array<{ eventId: string }>).filter((item) => item.eventId === "update.available");
  expect(updateNotifications).toHaveLength(1);
});

test("the Catalog model index recommends only models that fit this computer", () => {
  const index = { version: "2026-09-19", models: [
    { id: "embed-small", role: "embed", profile: "p16" as const, quality: 1, revision: "a", download: { url: "https://example.test/embed.gguf", sha256: "a".repeat(64), approx_bytes: 1 } },
    { id: "image-large", role: "image", profile: "p64" as const, quality: 2, revision: "b", download: { url: "https://example.test/image.gguf", sha256: "b".repeat(64), approx_bytes: 1 } },
    { id: "music-large", role: "music", profile: "p128" as const, quality: 2, revision: "c", download: { url: "https://example.test/music.gguf", sha256: "c".repeat(64), approx_bytes: 1 } },
  ] };
  expect(recommendationsFor(index, "p32")).toHaveLength(1);
  expect(recommendationsFor(index, "p32")[0]?.id).toBe("embed-small");
});

test("the model index uses the update headers and never fetches while checks are off", async () => {
  const requests: Request[] = [];
  await watchModels(async (input, init) => { requests.push(new Request(input as string, init)); return new Response("unreachable"); });
  expect(requests).toHaveLength(0);
  setUpdatesEnabled(true);
  await watchModels(async (input, init) => {
    requests.push(new Request(input as string, init));
    if (requests.length === 1) return new Response(JSON.stringify({ version: "0.2.0", notes: "New", pub_date: "2026-09-17", platforms: {} }));
    return new Response(JSON.stringify({ version: "2026-09-19", models: [] }));
  });
  expect([...requests[1]!.headers.keys()].sort()).toEqual(["if-none-match", "user-agent"]);
});
