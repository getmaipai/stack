import { afterEach, expect, test } from "bun:test";
import { setUpdatesEnabled, check } from "@/updates/check";

afterEach(() => setUpdatesEnabled(false));

test("the model revision watch reports a newer revision without installing it", async () => {
  setUpdatesEnabled(true);
  let installs = 0;
  const state = await check("models", async () => { installs += 1; return new Response(JSON.stringify({ version: "sha-new", notes: "Newer model", pub_date: "2026-09-17", platforms: { default: { url: "https://example.test/model", sha256: "b".repeat(64), size: 9, signature: "sig" } } }), { headers: { etag: "etag-new" } }); });
  expect(state.available).toBe("sha-new");
  expect(installs).toBe(1);
});
