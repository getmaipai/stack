import { describe, expect, test } from "bun:test";
import { formatRelative } from "@/lib/relativeTime";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const now = new Date(2026, 8, 3, 12, 0, 0, 0);
const iso = (ms: number) => new Date(now.getTime() - ms).toISOString();
const localDate = (ms: number) => { const d = new Date(ms); const year = d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`; return `${MONTHS[d.getMonth()]} ${d.getDate()}${year}`; };

describe("formatRelative", () => {
  test("under a minute is now", () => {
    expect(formatRelative(iso(30_000), now)).toBe("now");
    expect(formatRelative(iso(0), now)).toBe("now");
  });
  test("under an hour is minutes", () => {
    expect(formatRelative(iso(60_000), now)).toBe("1m");
    expect(formatRelative(iso(180_000), now)).toBe("3m");
    expect(formatRelative(iso(59 * 60_000), now)).toBe("59m");
  });
  test("under a day is hours", () => {
    expect(formatRelative(iso(3_600_000), now)).toBe("1h");
    expect(formatRelative(iso(2 * 3_600_000), now)).toBe("2h");
    expect(formatRelative(iso(23 * 3_600_000), now)).toBe("23h");
  });
  test("yesterday when one calendar day back", () => {
    expect(formatRelative(iso(25 * 3_600_000), now)).toBe("Yesterday");
    expect(formatRelative(iso(33 * 3_600_000), now)).toBe("Yesterday");
    expect(formatRelative(iso(47 * 3_600_000), now)).toBe("1d");
  });
  test("24 hours back that crosses a calendar day is Yesterday", () => {
    expect(formatRelative(iso(24 * 3_600_000), new Date(2026, 8, 3, 23, 0, 0, 0))).toBe("Yesterday");
  });
  test("under a week is days", () => {
    expect(formatRelative(iso(2 * 86_400_000), now)).toBe("2d");
    expect(formatRelative(iso(6 * 86_400_000), now)).toBe("6d");
  });
  test("a week or older is the short date, same year no year", () => {
    expect(formatRelative(iso(8 * 86_400_000), now)).toBe(localDate(now.getTime() - 8 * 86_400_000));
    expect(formatRelative(iso(30 * 86_400_000), now)).toBe(localDate(now.getTime() - 30 * 86_400_000));
  });
  test("different year shows the year", () => {
    expect(formatRelative("2025-05-01T00:00:00.000Z", now)).toBe(localDate(new Date("2025-05-01T00:00:00.000Z").getTime()));
  });
  test("future times render the short date", () => {
    expect(formatRelative(new Date(now.getTime() + 3_600_000).toISOString(), now)).toBe(localDate(now.getTime() + 3_600_000));
  });
});
