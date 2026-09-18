import { expect, test } from "bun:test";
import { scanSummary } from "@/lib/detectedScan";

test("the scan sentence reports found counts and the empty result", () => {
  expect(scanSummary({ tools: 2, modelFiles: 6 })).toBe("Found 2 tools and 6 model files");
  expect(scanSummary({ tools: 0, modelFiles: 0 })).toBe("Nothing new found");
});
