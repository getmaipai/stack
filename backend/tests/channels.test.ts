import { beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { channels } from "@/db/schema";
import { __resetChannelsForTests, createChannel, listChannels, testChannel } from "@/lib/channels";
import { __resetHealthForTests, list as listHealth } from "@/lib/health";

beforeEach(() => { __resetChannelsForTests(); __resetHealthForTests(); });

test("a scripted provider receives a test and only the verified stamp is public", async () => {
  const created = createChannel({ type: "telegram", name: "Family", config: { botToken: "123:secret-token", chatId: "42" } });
  const stored = db.select({ config: channels.config }).from(channels).where(eq(channels.id, String(created.id))).get();
  expect(stored?.config).toBeDefined();
  expect(stored?.config).not.toContain("secret-token");
  let request: { url: string; body: string } | undefined;
  const response = await testChannel(String(created.id), async (url, init) => { request = { url: String(url), body: String(init?.body) }; return new Response("{\"ok\":true}", { status: 200 }); });
  expect(response).toEqual({ ok: true });
  expect(request?.url).toContain("api.telegram.org/bot");
  expect(request?.body).toContain("MaiPai Home test alert");
  const publicRow = listChannels()[0]!;
  expect(publicRow).toMatchObject({ configPresent: true, status: "verified", verifiedAt: expect.any(String) });
  expect(JSON.stringify(publicRow)).not.toContain("secret-token");
});

test("three provider failures pause a channel and raise one actionable warning", async () => {
  const created = createChannel({ type: "ntfy", name: "Phone", config: { serverUrl: "https://ntfy.example", topic: "home", accessToken: "secret-token" } });
  const failing = async () => new Response("no", { status: 503 });
  for (let count = 0; count < 3; count++) await testChannel(String(created.id), failing);
  expect(listChannels()[0]).toMatchObject({ status: "failing", lastError: "ntfy returned HTTP 503." });
  expect(listHealth().filter((item) => item.code === `channel-unverified.${created.id}`)).toHaveLength(1);
});
