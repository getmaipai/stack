import { afterEach, expect, test } from "bun:test";
import { setUpdatesEnabled, check, state } from "@/updates/check";

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
