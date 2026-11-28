import { describe, expect, test } from "bun:test";
import { normalizeText, wordErrorRate } from "@/speech/wer";

describe("word error rate", () => {
  test("identical text has zero error", () => expect(wordErrorRate("one two three", "one two three")).toBe(0));
  test("counts a substitution over reference words", () => expect(wordErrorRate("one two three four", "one two five four")).toBe(0.25));
  test("ignores punctuation and case", () => expect(wordErrorRate("Hello, WORLD!", "hello world")).toBe(0));
  test("an empty hypothesis has one error per reference word", () => expect(wordErrorRate("one two", "")).toBe(1));
  test("keeps German umlauts", () => expect(normalizeText("Grüße für Köln")).toBe("grüße für köln"));
});
