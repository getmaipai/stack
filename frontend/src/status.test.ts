import { describe, expect, test } from "bun:test";
import { statusDotClass, statusFor, statusMap, type StatusKind } from "@/lib/status";

const ALL_KINDS: StatusKind[] = ["running", "ready", "stopped", "detected", "update", "warning", "error", "loading", "disabled", "unavailable"];

describe("statusMap", () => {
  test("covers every status kind with a label and a hue", () => {
    for (const kind of ALL_KINDS) {
      const entry = statusMap[kind];
      expect(entry, kind).toBeDefined();
      expect(entry.label.length, kind).toBeGreaterThan(0);
      expect(["teal", "blue", "violet", "orange", "red", "muted"]).toContain(entry.hue);
    }
  });

  test("matches the spec's State table labels and hues", () => {
    expect(statusMap.running).toEqual({ label: "Running", hue: "teal", dot: true });
    expect(statusMap.ready).toEqual({ label: "Ready", hue: "teal", dot: true });
    expect(statusMap.stopped).toEqual({ label: "Stopped", hue: "muted", dot: true });
    expect(statusMap.detected).toEqual({ label: "Detected", hue: "blue", dot: true });
    expect(statusMap.update).toEqual({ label: "Update available", hue: "violet", dot: true });
    expect(statusMap.warning).toEqual({ label: "Needs attention", hue: "orange", dot: true });
    expect(statusMap.error).toEqual({ label: "Error", hue: "red", dot: true });
    expect(statusMap.loading).toEqual({ label: "Loading", hue: "muted", dot: false });
    expect(statusMap.disabled).toEqual({ label: "Unavailable", hue: "muted", dot: true });
    expect(statusMap.unavailable).toEqual({ label: "Not reported", hue: "muted", dot: true });
  });
});

describe("statusFor", () => {
  test("returns the map entry", () => {
    expect(statusFor("running")).toBe(statusMap.running);
  });
});

describe("statusDotClass", () => {
  test("named hues use the generic --hue-<hue> token", () => {
    expect(statusDotClass("running")).toBe("bg-[var(--hue-teal)]");
    expect(statusDotClass("detected")).toBe("bg-[var(--hue-blue)]");
    expect(statusDotClass("update")).toBe("bg-[var(--hue-violet)]");
    expect(statusDotClass("warning")).toBe("bg-[var(--hue-orange)]");
    expect(statusDotClass("error")).toBe("bg-[var(--hue-red)]");
  });
  test("muted uses --muted-foreground", () => {
    expect(statusDotClass("stopped")).toBe("bg-[var(--muted-foreground)]");
    expect(statusDotClass("loading")).toBe("bg-[var(--muted-foreground)]");
  });
});
