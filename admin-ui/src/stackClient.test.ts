// The admin page's StackClient (src/stackClient.ts): each method is one /stack/v1 call with the session cookie and the CSRF header,
// a refusal keeps the Stack's own sentence and code, and the event feed is shared. fetch and EventSource are scripted; nothing leaves the test.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { StackClientError } from "@maipai/ui/src/stack/StackClient";
import { createStackClient } from "./stackClient";

interface Sent { method: string; path: string; headers: Record<string, string>; body: unknown; credentials?: string }
let sent: Sent[] = [];
let answer: (path: string, method: string) => { status: number; json: unknown } = () => ({ status: 200, json: { ok: true } });
const realFetch = globalThis.fetch;
const realSource = (globalThis as { EventSource?: unknown }).EventSource;

class FakeSource {
  static made: FakeSource[] = [];
  closed = false;
  onmessage: (() => void) | null = null;
  listeners = new Map<string, () => void>();
  constructor(readonly url: string) { FakeSource.made.push(this); }
  addEventListener(name: string, fn: () => void) { this.listeners.set(name, fn); }
  close() { this.closed = true; }
}

beforeEach(() => {
  sent = []; FakeSource.made = [];
  answer = () => ({ status: 200, json: { ok: true } });
  globalThis.fetch = (async (path: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    sent.push({ method, path, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined, credentials: init.credentials });
    const a = answer(path, method);
    return new Response(JSON.stringify(a.json), { status: a.status });
  }) as unknown as typeof fetch;
  (globalThis as { EventSource?: unknown }).EventSource = FakeSource;
});
afterEach(() => { globalThis.fetch = realFetch; (globalThis as { EventSource?: unknown }).EventSource = realSource; });

test("a read is a GET of /stack/v1/choices with the session cookie and no CSRF header", async () => {
  answer = () => ({ status: 200, json: { categories: [] } });
  const view = await createStackClient().readChoices();
  expect(view).toEqual({ categories: [] } as never);
  expect(sent[0]).toMatchObject({ method: "GET", path: "/stack/v1/choices", credentials: "same-origin" });
  expect(sent[0]!.headers["x-stack-admin"]).toBeUndefined();
});

test("every write carries the CSRF header and goes to the route the page's call names", async () => {
  const client = createStackClient();
  await client.setRoleEnabled("chat", false);
  await client.setRolePriorities({ chat: 20, tts: 10 });
  await client.chooseModel("chat", "boost", { model: "m1", profile: "p64" });
  await client.setOrder("pictures", { order: ["a", "b"], off: ["c"] });
  await client.recommended(false);
  await client.installModel("part/with space");
  await client.removeModel("m1");
  await client.removeUnused({ ids: ["x"], tidy: false });
  await client.addModel({ source: "org/repo", tier: "standard", use: true });
  expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
    "PUT /stack/v1/settings", "PUT /stack/v1/settings", "PUT /stack/v1/choices/chat/boost", "PUT /stack/v1/choices/pictures/order", "POST /stack/v1/choices/recommended",
    "POST /stack/v1/parts/part%2Fwith%20space/install", "DELETE /stack/v1/parts/m1", "POST /stack/v1/choices/unused/remove", "POST /stack/v1/choices/add-model",
  ]);
  for (const s of sent) expect(s.headers["x-stack-admin"]).toBe("1");
  expect(sent[0]!.body).toEqual({ "stack.roles.chat.enabled": false });
  expect(sent[1]!.body).toEqual({ "stack.roles.chat.priority": 20, "stack.roles.tts.priority": 10 });
  expect(sent[2]!.body).toEqual({ model: "m1", profile: "p64" });
  expect(sent[4]!.body).toEqual({ dry_run: false });
  // The Stack's JSON validator answers 400 "Malformed JSON" to an empty body that claims to be JSON, so an install sends {}.
  expect(sent[5]!.body).toEqual({});
});

test("a dry run writes nothing, so the shell is not told to refresh; a real write is", async () => {
  let writes = 0;
  const client = createStackClient(() => { writes++; });
  await client.recommended(true);
  expect(sent[0]!.body).toEqual({ dry_run: true });
  expect(writes).toBe(0);
  await client.readUnused();
  expect(writes).toBe(0);
  await client.setRoleEnabled("stt", true);
  await client.recommended(false);
  expect(writes).toBe(2);
});

test("a refusal reaches the page as the Stack's own sentence and code", async () => {
  answer = () => ({ status: 409, json: { error: "That model does not fit in this computer's memory.", code: "does_not_fit" } });
  const error = await createStackClient().chooseModel("chat", "max", { model: "big" }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(StackClientError);
  expect((error as StackClientError).message).toBe("That model does not fit in this computer's memory.");
  expect((error as StackClientError).code).toBe("does_not_fit");
});

test("one event feed serves every listener and closes with the last one", async () => {
  const client = createStackClient();
  let a = 0; let b = 0;
  const stopA = client.subscribe!(() => { a++; });
  const stopB = client.subscribe!(() => { b++; });
  expect(FakeSource.made.length).toBe(1);
  expect(FakeSource.made[0]!.url).toBe("/stack/v1/events");
  FakeSource.made[0]!.listeners.get("model.installed")!();
  await new Promise((r) => setTimeout(r, 300));
  expect([a, b]).toEqual([1, 1]);
  client.changed();
  await new Promise((r) => setTimeout(r, 300));
  expect([a, b]).toEqual([2, 2]);
  stopA();
  expect(FakeSource.made[0]!.closed).toBe(false);
  stopB();
  expect(FakeSource.made[0]!.closed).toBe(true);
});
