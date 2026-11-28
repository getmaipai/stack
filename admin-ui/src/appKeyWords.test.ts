import { expect, test } from "bun:test";
import { baseUrl, DEFAULT_SCOPES, scopeLabel, SCOPE_CHOICES, useWords } from "./appKeyWords";

test("a key that was never used says so, and a used one says when and how often", () => {
  expect(useWords(null, 0, () => "x")).toBe("Never used.");
  expect(useWords("2026-11-28T10:00:00Z", 1, () => "2 minutes ago")).toBe("Last used 2 minutes ago, 1 request in all.");
  expect(useWords("2026-11-28T10:00:00Z", 12, () => "now")).toBe("Last used now, 12 requests in all.");
});
test("the base address is this page's address plus /v1", () => {
  expect(baseUrl("http://127.0.0.1:8770")).toBe("http://127.0.0.1:8770/v1");
  expect(baseUrl("http://127.0.0.1:8770/")).toBe("http://127.0.0.1:8770/v1");
});
test("opened over Tailscale, it still shows the local address", () => {
  expect(baseUrl("http://100.101.102.103:8770")).toBe("http://127.0.0.1:8770/v1");
  expect(baseUrl("http://localhost:8770")).toBe("http://localhost:8770/v1");
});
test("every default scope is a scope the page offers, and labels are plain", () => {
  for (const id of DEFAULT_SCOPES) expect(SCOPE_CHOICES.some((s) => s.id === id)).toBe(true);
  expect(scopeLabel("models")).toBe("Models list");
  expect(scopeLabel("odd")).toBe("odd");
});
