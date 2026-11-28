import { describe, expect, it } from "bun:test";
import { chooseServing, type FailoverChoiceInput } from "../src/lib/failoverChoice";

describe("chooseServing", () => {
  it("serves a healthy primary without switching", () => {
    expect(chooseServing({ primary: "p", fallbacks: ["f"], health: { p: "healthy", f: "healthy" } })).toEqual({
      serve: "p", switched: false, notice: null, skipped: [],
    });
  });

  it("uses the first usable fallback when the primary is unhealthy", () => {
    expect(chooseServing({ primary: "p", fallbacks: ["f1", "f2"], health: { p: "unhealthy", f1: "healthy", f2: "healthy" } })).toEqual({
      serve: "f1", switched: true, notice: "p is not answering, f1 is answering instead.",
      skipped: [{ model: "p", why: "unhealthy" }],
    });
  });

  it("skips a fallback that does not fit", () => {
    expect(chooseServing({ primary: "p", fallbacks: ["f1", "f2"], health: { p: "unhealthy", f1: "healthy", f2: "healthy" }, fits: { f1: false } })).toEqual({
      serve: "f2", switched: true, notice: "p is not answering, f2 is answering instead.",
      skipped: [{ model: "p", why: "unhealthy" }, { model: "f1", why: "does-not-fit" }],
    });
  });

  it("reports no model when all candidates are unhealthy", () => {
    expect(chooseServing({ primary: "p", fallbacks: ["f"], health: { p: "unhealthy", f: "unhealthy" } })).toEqual({
      serve: null, switched: true, notice: "No model is answering for this role.",
      skipped: [{ model: "p", why: "unhealthy" }, { model: "f", why: "unhealthy" }],
    });
  });

  it("skips unknown or missing health and emits no success notice", () => {
    expect(chooseServing({ primary: "p", fallbacks: [], health: { p: "unknown" } })).toEqual({
      serve: null, switched: true, notice: "No model is answering for this role.", skipped: [{ model: "p", why: "health-unknown" }],
    });
    expect(chooseServing({ primary: "p", fallbacks: ["f"], health: { p: "unhealthy" } })).toEqual({
      serve: null, switched: true, notice: "No model is answering for this role.", skipped: [{ model: "p", why: "unhealthy" }, { model: "f", why: "health-unknown" }],
    });
  });

  it("ignores duplicate models after their first occurrence", () => {
    expect(chooseServing({ primary: "p", fallbacks: ["p", "f", "f"], health: { p: "unhealthy", f: "healthy" } })).toEqual({
      serve: "f", switched: true, notice: "p is not answering, f is answering instead.",
      skipped: [{ model: "p", why: "unhealthy" }],
    });
  });

  it("does not mutate its input", () => {
    const input: FailoverChoiceInput = { primary: "p", fallbacks: ["f"], health: { p: "unhealthy", f: "healthy" }, fits: { f: true } };
    const before = structuredClone(input);
    chooseServing(input);
    expect(input).toEqual(before);
  });
});
