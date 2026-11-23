import { describe, expect, test } from "bun:test";
import { findSites } from "../../scripts/lint-no-feature-names";

const FILE = "backend/src/example.ts";

describe("findSites", () => {
  test("finds a feature id literal in a comparison", () => {
    const sites = findSites(FILE, `if (x === "coding") {\n`);
    expect(sites.length).toBe(1);
    expect(sites[0]?.literal).toBe("coding");
    expect(sites[0]?.kind).toBe("feature");
    expect(sites[0]?.file).toBe(FILE);
  });

  test("finds a template id literal", () => {
    const sites = findSites(FILE, `const t = "p64";\n`);
    expect(sites.length).toBe(1);
    expect(sites[0]?.literal).toBe("p64");
    expect(sites[0]?.kind).toBe("template");
  });

  test("finds a model id literal", () => {
    const sites = findSites(FILE, `const m = "qwen3.8-27b-ud-q4-k-m";\n`);
    expect(sites.length).toBe(1);
    expect(sites[0]?.literal).toBe("qwen3.8-27b-ud-q4-k-m");
    expect(sites[0]?.kind).toBe("model");
  });

  test("ignores commented lines and trailing comments", () => {
    const text = [`// use "chat" here`, `const a = "stt"; // "chat"`, ""].join("\n");
    const sites = findSites(FILE, text);
    expect(sites.length).toBe(1);
    expect(sites[0]?.literal).toBe("stt");
    expect(sites[0]?.line).toBe(2);
  });

  test("does not match words that only contain a feature id", () => {
    const sites = findSites(FILE, `const w = "chatty";\n`);
    expect(sites.length).toBe(0);
  });

  test("line numbers are 1-based", () => {
    const text = ["const a = 1;", "const b = 'vision';", ""].join("\n");
    const sites = findSites(FILE, text);
    expect(sites.length).toBe(1);
    expect(sites[0]?.line).toBe(2);
  });
});
