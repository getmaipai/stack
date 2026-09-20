import { beforeEach, expect, test } from "bun:test";
import { db } from "@/db";
import { detected } from "@/db/schema";
import { __resetChannelsForTests, createChannel } from "@/lib/channels";
import { issueClient, resolveClient } from "@/lib/clients";
import { clearModelsForTests, upsertModel } from "@/lib/modelStore";
import { __resetComponentsCacheForTests, componentsSummary, listComponents } from "@/lib/components";
import { emit, listActivity } from "@/lib/events";
import { app } from "@/app";
import { testClientHeaders } from "./authTest";

beforeEach(() => {
  clearModelsForTests();
  __resetChannelsForTests();
  db.delete(detected).run();
  __resetComponentsCacheForTests();
});

test("a model row is built from the model store, with its subtype from its roles", async () => {
  upsertModel({ id: "test-llm", nickname: "Test LLM", roles: ["chat"], source: "catalog", provenance: {}, revision: "main", sha256: "a".repeat(64), sizeBytes: 1_000, licence: "MIT", installedAt: new Date().toISOString() });
  const { components } = await listComponents();
  const row = components.find((c) => c.id === "model:test-llm");
  expect(row).toBeDefined();
  expect(row?.category).toBe("models");
  expect(row?.subtype).toBe("LLMs");
  expect(row?.name).toBe("Test LLM");
  expect(row?.status).toBe("stopped");
});

test("an unadopted detected install is a runtime row with status detected", async () => {
  const now = new Date().toISOString();
  db.insert(detected).values({ id: "ollama:http://127.0.0.1:11434", kind: "ollama", name: "Ollama", version: "0.6.1", where: "http://127.0.0.1:11434", couldHold: "[]", firstSeen: now, lastSeen: now, forgotten: 0, adopted: 0, target: null }).run();
  const { components } = await listComponents();
  const row = components.find((c) => c.id === "runtime:detected:ollama:http://127.0.0.1:11434");
  expect(row).toBeDefined();
  expect(row?.category).toBe("runtimes");
  expect(row?.status).toBe("detected");
});

test("an adopted detected install produces no runtime row", async () => {
  const now = new Date().toISOString();
  db.insert(detected).values({ id: "ollama:http://127.0.0.1:11434", kind: "ollama", name: "Ollama", version: "0.6.1", where: "http://127.0.0.1:11434", couldHold: "[]", firstSeen: now, lastSeen: now, forgotten: 0, adopted: 1, target: null }).run();
  const { components } = await listComponents();
  expect(components.some((c) => c.id === "runtime:detected:ollama:http://127.0.0.1:11434")).toBe(false);
});

test("a client holding the coding role is an app row; one that doesn't is skipped", async () => {
  const codingKey = issueClient("Coding tool", ["coding"]);
  issueClient("Voice only", ["stt"]);
  resolveClient(codingKey);
  const { components } = await listComponents();
  const appRows = components.filter((c) => c.category === "apps");
  expect(appRows.some((row) => row.name === "Coding tool" && row.subtype === "Coding")).toBe(true);
  expect(appRows.some((row) => row.name === "Voice only")).toBe(false);
});

test("a client whose name says agent or harness is subtyped Agents, not Coding", async () => {
  issueClient("Aider agent", ["coding"]);
  const { components } = await listComponents();
  const row = components.find((c) => c.name === "Aider agent");
  expect(row?.subtype).toBe("Agents");
});

test("Chat, Image and the Library are always present app rows even with no clients at all", async () => {
  const { components } = await listComponents();
  const names = components.filter((c) => c.category === "apps").map((c) => c.name);
  expect(names).toContain("Chat");
  expect(names).toContain("Image");
  expect(names).toContain("Library");
});

test("a channel is an extensions row, and the Hugging Face mirror always has one", async () => {
  createChannel({ type: "telegram", name: "Family Telegram", config: { botToken: "123:secret", chatId: "1" } });
  const { components } = await listComponents();
  const extensionRows = components.filter((c) => c.category === "extensions");
  expect(extensionRows.some((row) => row.name === "Family Telegram")).toBe(true);
  expect(extensionRows.some((row) => row.name === "Hugging Face mirror")).toBe(true);
});

test("system rows exist for accelerators, drivers, and each engine dependency", async () => {
  const { components } = await listComponents();
  const systemRows = components.filter((c) => c.category === "system");
  expect(systemRows.some((row) => row.subtype === "Drivers")).toBe(true);
  expect(systemRows.some((row) => row.subtype === "Dependencies")).toBe(true);
});

test("adapters, workflows and training are always empty with managed: false", async () => {
  const { components, managed } = await listComponents();
  for (const category of ["adapters", "workflows", "training"] as const) {
    expect(components.filter((c) => c.category === category)).toHaveLength(0);
    expect(managed[category]).toBe(false);
  }
  expect(managed.models).toBe(true);
});

test("the summary counts match the component list, per category and overall", async () => {
  upsertModel({ id: "test-llm", roles: ["chat"], source: "catalog", provenance: {}, revision: "main", sha256: "a".repeat(64), sizeBytes: 1_000, licence: "MIT", installedAt: new Date().toISOString() });
  const { components } = await listComponents();
  const summary = await componentsSummary();
  expect(summary.perCategory.models).toBe(components.filter((c) => c.category === "models").length);
  expect(summary.installed).toBe(components.filter((c) => c.status !== "detected").length);
  expect(summary.running).toBe(components.filter((c) => c.status === "running").length);
});

test("GET /stack/v1/components filters by category and status", async () => {
  upsertModel({ id: "test-llm", roles: ["chat"], source: "catalog", provenance: {}, revision: "main", sha256: "a".repeat(64), sizeBytes: 1_000, licence: "MIT", installedAt: new Date().toISOString() });
  const byCategory = await (await app.request("/stack/v1/components?category=models", { headers: testClientHeaders })).json() as { components: Array<{ category: string }> };
  expect(byCategory.components.length).toBeGreaterThan(0);
  expect(byCategory.components.every((row) => row.category === "models")).toBe(true);
  const byStatus = await (await app.request("/stack/v1/components?status=stopped", { headers: testClientHeaders })).json() as { components: Array<{ status: string }> };
  expect(byStatus.components.every((row) => row.status === "stopped")).toBe(true);
  const byBoth = await (await app.request("/stack/v1/components?category=apps&status=stopped", { headers: testClientHeaders })).json() as { components: unknown[] };
  expect(byBoth.components).toHaveLength(0);
});

test("GET /stack/v1/components/summary returns the same shape over HTTP", async () => {
  const response = await app.request("/stack/v1/components/summary", { headers: testClientHeaders });
  expect(response.status).toBe(200);
  const body = await response.json() as { installed: number; perCategory: Record<string, number> };
  expect(typeof body.installed).toBe("number");
  expect(typeof body.perCategory.models).toBe("number");
});

test("an installed model's activity shows up in GET /stack/v1/activity", async () => {
  emit({ id: "model.installed", data: { model: "test-llm" } });
  const activity = listActivity() as Array<{ eventId: string }>;
  expect(activity.some((item) => item.eventId === "model.installed")).toBe(true);
  const response = await app.request("/stack/v1/activity", { headers: testClientHeaders });
  const body = await response.json() as { activity: Array<{ eventId: string }> };
  expect(body.activity.some((item) => item.eventId === "model.installed")).toBe(true);
});
