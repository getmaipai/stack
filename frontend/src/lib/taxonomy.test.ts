import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { categories, groups } from "@/lib/taxonomy";

const EXPECTED_GROUPS = [
  { label: "STACK", labels: ["Overview", "Models", "Adapters", "Apps", "Runtimes", "Workflows", "Extensions", "Training"] },
  { label: "System", labels: ["System / Drivers", "Clients", "Monitoring", "Tester"] },
  { label: "Resources", labels: ["Packages", "Docs"] },
  { label: "MANAGE", labels: ["Settings", "Logs", "Alerts"] },
];

const EXPECTED_SUBTYPES: Record<string, string[]> = {
  Models: ["LLMs", "Image", "Video", "Audio", "Embeddings"],
  Adapters: ["LoRAs", "ControlNets", "VAEs"],
  Apps: ["Chat", "Image", "Coding", "Agents", "Knowledge"],
  Runtimes: ["Ollama", "llama.cpp", "vLLM", "Diffusers"],
  Workflows: ["ComfyUI workflows", "n8n", "Langflow"],
  Extensions: ["Plugins", "MCP Servers", "Integrations"],
  Training: ["Trainers", "Fine-tuning", "Datasets"],
  "System / Drivers": ["Drivers", "Accelerators", "Dependencies"],
};

const EXPECTED_CATEGORIES = ["Models", "Adapters", "Apps", "Runtimes", "Workflows", "Extensions", "Training", "System"];

test("the taxonomy's four groups carry the spec's 17 destinations in order", () => {
  expect(groups.map((group) => group.label)).toEqual(EXPECTED_GROUPS.map((group) => group.label));
  groups.forEach((group, index) => { expect(group.destinations.map((destination) => destination.label)).toEqual(EXPECTED_GROUPS[index]!.labels); });
});

test("every destination with subtypes matches the spec's list verbatim", () => {
  for (const group of groups) {
    for (const destination of group.destinations) {
      const expected = EXPECTED_SUBTYPES[destination.label];
      if (expected) expect(destination.subtypes).toEqual(expected);
      else expect(destination.subtypes).toBeUndefined();
    }
  }
});

test("every destination has a path, a subtitle and an icon", () => {
  for (const group of groups) {
    for (const destination of group.destinations) {
      expect(destination.path.startsWith("/")).toBe(true);
      expect(destination.subtitle.length).toBeGreaterThan(0);
      expect(destination.icon.length).toBeGreaterThan(0);
    }
  }
});

test("the eight categories match the spec's section 4 labels, in order", () => {
  expect(categories.map((category) => category.label)).toEqual(EXPECTED_CATEGORIES);
  for (const category of categories) { expect(category.hue.startsWith("--cat-")).toBe(true); expect(category.icon.length).toBeGreaterThan(0); }
});

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) collectFiles(path, out);
    else out.push(path);
  }
  return out;
}

test("no other file under frontend/src declares the destination list", () => {
  const root = resolve(import.meta.dir, "..");
  const offenders = collectFiles(root)
    .filter((path) => path !== resolve(import.meta.dir, "taxonomy.ts") && path !== resolve(import.meta.dir, "taxonomy.test.ts"))
    .filter((path) => readFileSync(path, "utf8").includes("\"Adapters\""));
  expect(offenders).toEqual([]);
});
