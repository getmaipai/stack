// The admin page's plain-words time and size wording (admin-ui/src/format.ts).
import { expect, test } from "bun:test";
import { ago } from "../../admin-ui/src/format";

const now = Date.parse("2026-11-21T12:00:00Z");
const before = (ms: number) => new Date(now - ms).toISOString();

test("ago spells out the unit and uses the singular for one", () => {
  expect(ago(before(20_000), now)).toBe("just now");
  expect(ago(before(60_000), now)).toBe("1 minute ago");
  expect(ago(before(40 * 60_000), now)).toBe("40 minutes ago");
  expect(ago(before(3_600_000), now)).toBe("1 hour ago");
  expect(ago(before(3 * 3_600_000), now)).toBe("3 hours ago");
  expect(ago(before(2 * 86_400_000), now)).toBe("2 days ago");
  expect(ago("not a date", now)).toBe("");
});
