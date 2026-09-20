import { describe, expect, test } from "bun:test";
import { absoluteTime, formatBytes, formatDuration, formatPercent, formatRate, formatUsedOfTotal, formatVersion } from "@/lib/format";

describe("formatBytes", () => {
  test("picks the right unit and trims whole numbers", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(410 * 1_048_576)).toBe("410 MB");
    expect(formatBytes(42 * 1_073_741_824)).toBe("42 GB");
    expect(formatBytes(1.2 * 1_099_511_627_776)).toBe("1.2 TB");
  });
  test("null is Not reported", () => {
    expect(formatBytes(null)).toBe("Not reported");
  });
});

describe("formatPercent", () => {
  test("one decimal under 10, whole numbers at or above", () => {
    expect(formatPercent(4.2)).toBe("4.2%");
    expect(formatPercent(9.96)).toBe("10.0%");
    expect(formatPercent(18)).toBe("18%");
    expect(formatPercent(99.6)).toBe("100%");
  });
  test("null is Not reported", () => {
    expect(formatPercent(null)).toBe("Not reported");
  });
  test("clamps out-of-range values so the label never disagrees with a clamped bar", () => {
    expect(formatPercent(-3.2)).toBe("0.0%");
    expect(formatPercent(142)).toBe("100%");
  });
});

describe("formatRate", () => {
  test("whole numbers for tok/s, req/s and ms; one decimal for Gbps and Mbps", () => {
    expect(formatRate(28.4, "tok/s")).toBe("28 tok/s");
    expect(formatRate(6, "req/s")).toBe("6 req/s");
    expect(formatRate(12, "ms")).toBe("12 ms");
    expect(formatRate(1.2, "Gbps")).toBe("1.2 Gbps");
    expect(formatRate(500, "Mbps")).toBe("500 Mbps");
  });
  test("null is Not reported", () => {
    expect(formatRate(null, "tok/s")).toBe("Not reported");
  });
});

describe("formatDuration", () => {
  test("seconds, minutes, hours+minutes, days+hours", () => {
    expect(formatDuration(48)).toBe("48s");
    expect(formatDuration(5 * 60)).toBe("5m");
    expect(formatDuration(5 * 3600 + 12 * 60)).toBe("5h 12m");
    expect(formatDuration(5 * 3600)).toBe("5h");
    expect(formatDuration(3 * 86400 + 2 * 3600)).toBe("3d 2h");
    expect(formatDuration(3 * 86400)).toBe("3d");
  });
  test("null is Not reported", () => {
    expect(formatDuration(null)).toBe("Not reported");
  });
});

describe("formatUsedOfTotal", () => {
  test("one unit, chosen from the total", () => {
    expect(formatUsedOfTotal(8.4 * 1_073_741_824, 25.8 * 1_073_741_824)).toBe("8.4 / 25.8 GB");
  });
  test("either null is Not reported", () => {
    expect(formatUsedOfTotal(null, 100)).toBe("Not reported");
    expect(formatUsedOfTotal(100, null)).toBe("Not reported");
  });
  test("a zero total (an unmeasured device) is Not reported, not a raw byte count", () => {
    expect(formatUsedOfTotal(8_589_934_592, 0)).toBe("Not reported");
  });
});

describe("formatVersion", () => {
  test("current alone, or current with an available update", () => {
    expect(formatVersion("0.5.7", null)).toBe("v0.5.7");
    expect(formatVersion("0.5.7", "0.5.7")).toBe("v0.5.7");
    expect(formatVersion("0.5.7", "0.5.8")).toBe("v0.5.7 → v0.5.8");
  });
  test("null current is Not reported", () => {
    expect(formatVersion(null, "0.5.8")).toBe("Not reported");
  });
});

describe("absoluteTime", () => {
  test("renders a full local date and time", () => {
    const iso = "2026-09-19T22:14:00.000Z";
    expect(absoluteTime(iso)).toBe(new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }));
  });
});
