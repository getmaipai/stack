// The Helper (HELPER-01): admin only, read tools run at once, every change is a proposal card that runs only
// when that exact card is confirmed, and refusals for what it must never do. The model and the routes it
// calls are scripted; nothing here loads a model or restarts anything.
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { serveOptions } from "@/daemon";
import { __resetAdultViewForTests } from "@/lib/adultView";
import { __resetAdminAuthRateLimitsForTests, resetAdmin } from "@/lib/adminAuth";
import { __expireProposalForTests, __resetHelperForTests, cleanReply, groundReply, salvageCalls, setHelperModelForTests, setHelperRouteForTests, type ModelCall } from "@/lib/helper";
import { HELPER_TOOLS } from "@/lib/helperTools";
import { ROLES } from "@/roles";
import { dataDir } from "@/lib/paths";
import { logger } from "@/lib/log";
import { __resetSettingsForTests } from "@/settings";

const TOKEN = "t".repeat(40);
const PASSWORD = "correct horse battery";
let server: ReturnType<typeof Bun.serve>;
let base = "";
let lines: string[] = [];
let spy: ReturnType<typeof spyOn>;
const previous = process.env.STACK_HOME_VIEW_TOKEN;
const routeCalls: Array<[string, string, unknown]> = [];
const ROLE_VIEWS = [
  { id: "chat", label: "Chat", enabled: true, priority: 100, state: { state: "ready" }, model: { id: "m", sizeBytes: 2_000_000_000 } },
  { id: "coding", label: "Coding", enabled: true, priority: 100, state: { state: "installed" }, model: { id: "qwen3.8-27b-ud-q4-k-m", sizeBytes: 17_000_000_000 }, coding: { engine: "llama-server" } },
  { id: "video", label: "Video", enabled: true, priority: 100, state: { state: "installed" }, model: null },
  { id: "music", label: "Music", enabled: false, priority: 100, state: { state: "installed" }, model: null },
  { id: "stt", label: "Voice in", enabled: true, priority: 100, state: { state: "ready" }, model: null },
  { id: "tts", label: "Voice out", enabled: true, priority: 100, state: { state: "ready" }, model: null, tts: { engine: "pocket-tts" } },
];
/** The routes the Helper calls, answered from fixed data; every call is recorded. */
function fakeRoute(over: Record<string, { status: number; json: unknown }> = {}) {
  return async (method: string, path: string, body?: unknown) => {
    routeCalls.push([method, path, body]);
    for (const [prefix, answer] of Object.entries(over)) if (`${method} ${path}`.startsWith(prefix)) return answer;
    if (path === "/stack/v1/roles") return { status: 200, json: { roles: ROLE_VIEWS } };
    if (path === "/stack/v1/engines") return { status: 200, json: { engines: [{ name: "llama-server", running: true }, { name: "pocket-tts", running: false }, { name: "splash", running: false }] } };
    if (path === "/stack/v1/models") return { status: 200, json: { models: [] } };
    if (path === "/stack/v1/choices") return { status: 200, json: { categories: [{ id: "coding", label: "Coding", role: "coding", tiered: false, candidates: [{ id: "qwen3.8-27b-ud-q4-k-m", label: "Qwen3.8 27B", summary: "Writes code.", version: "3.8", quantization: "4-bit, compact", license: "Apache-2.0", engine: "llama-server", size_bytes: 17_000_000_000, state: "installed", percent: null, enabled: true }], tiers: [{ tier: "standard", cap_bytes: null, chosen: "qwen3.8-27b-ud-q4-k-m", chosen_by: "recommended", options: [], problem: null }] }] } };
    if (path === "/stack/v1/updates") return { status: 200, json: { checksEnabled: true, engines: [{ name: "llama-server", installed: "b1", available: "b2", lastChecked: null }] } };
    if (path === "/stack/v1/memory") return { status: 200, json: { memory: { total_bytes: 137_438_953_472, available_bytes: 87_000_000_000, pressure: "normal" }, ledger: { budget_bytes: 96_000_000_000, warm_bytes: 0, reserved_bytes: 0, items: [] }, stack: { processes: [] }, top_consumers: [{ pid: 7, name: "splash", bytes: 25_062_267_288, stack: true }] } };
    if (path === "/stack/v1/profiles/recommend") return { status: 200, json: { matched: null, custom_recommended: { plan: { budget: { total_bytes: 137_438_953_472 }, roles: [{ role: "music", enabled: true, priority: 100 }, { role: "video", enabled: true, priority: 50 }] } } } };
    return { status: 200, json: { ok: true } };
  };
}

beforeAll(() => {
  process.env.STACK_HOME_VIEW_TOKEN = TOKEN;
  __resetAdultViewForTests();
  server = Bun.serve({ ...serveOptions(), port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => {
  server.stop(true);
  await resetAdmin(dataDir);
  if (previous === undefined) delete process.env.STACK_HOME_VIEW_TOKEN; else process.env.STACK_HOME_VIEW_TOKEN = previous;
  __resetAdultViewForTests();
});
beforeEach(() => {
  __resetAdminAuthRateLimitsForTests(); __resetHelperForTests(); routeCalls.length = 0; lines = [];
  setHelperRouteForTests(fakeRoute());
  spy = spyOn(logger, "appendLine").mockImplementation((line: string) => { lines.push(line); });
});
afterEach(() => { spy.mockRestore(); __resetHelperForTests(); __resetSettingsForTests(); });

async function adminHeaders(): Promise<Record<string, string>> {
  const code = await resetAdmin(dataDir);
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await post("/stack/v1/admin/setup", { code, password: PASSWORD })).status).toBe(200);
  const res = await post("/stack/v1/admin/login", { password: PASSWORD });
  const token = /stack_admin=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]!;
  return { cookie: `stack_admin=${token}`, "x-stack-admin": "1", origin: base, "content-type": "application/json" };
}
const confirmCall = (id: string, body: unknown, headers: Record<string, string>) => fetch(`${base}/stack/v1/helper/actions/${id}/confirm`, { method: "POST", headers, body: JSON.stringify(body) });
const cancelCall = (id: string, headers: Record<string, string>) => fetch(`${base}/stack/v1/helper/actions/${id}/cancel`, { method: "POST", headers });
type Card = { id: string; action: string; params: Record<string, string | number | boolean>; summary: string; changes: Array<{ label: string; from: string; to: string }>; note: string | null; expires_at: string };
type Said = { reply: string; tools: string[]; pending: Card[]; calls: Array<{ name: string; args: Record<string, unknown> }>; dropped: number };
const audits = () => lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, string>).filter((e) => e.event?.startsWith("admin.action.helper."));
const say = (message: string, headers: Record<string, string>) => fetch(`${base}/stack/v1/helper/chat`, { method: "POST", headers, body: JSON.stringify({ message }) });
const call = (name: string, args: Record<string, unknown>) => ({ message: { content: "", tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } });
const text = (content: string) => ({ message: { content } });
/** A model that plays the given answers in order. */
const scripted = (...answers: Array<ReturnType<typeof call> | ReturnType<typeof text>>): ModelCall => { let i = 0; return async () => answers[Math.min(i++, answers.length - 1)] as never; };


const NO_MODEL: ModelCall = async () => { throw new Error("The model must not be asked for this."); };
const askJson = async (message: string, admin: Record<string, string>) => (await say(message, admin)).json() as Promise<Said>;

test("the Helper is its own role: not on /v1, no Home route, loads on demand", () => {
  expect(ROLES.helper.residency).toBe("jit");
  expect(ROLES.helper.endpoints).toEqual([]);
});

test("the tool list has one way to change things and none to reboot, edit files, run commands, remove models or read secrets", () => {
  const names = HELPER_TOOLS.map((t) => t.name).join(" ");
  expect(names).not.toMatch(/reboot|shell|exec|file|password|token|secret|remove|delete/);
  expect(HELPER_TOOLS.filter((t) => t.kind === "write").map((t) => t.name)).toEqual(["propose_action"]);
  const spec = HELPER_TOOLS.find((t) => t.name === "propose_action")!;
  expect(spec.parameters.additionalProperties).toBe(false);
  expect([...spec.parameters.properties.action!.enum!].sort()).toEqual(["apply_profile", "apply_update", "check_updates", "restart_engine", "restart_stack", "rollback_update", "set_role_enabled", "set_role_priority", "set_setting"]);
});

test("no sign-in and Home's token are both refused", async () => {
  setHelperModelForTests(scripted(text("hi")));
  expect((await say("hi", { "content-type": "application/json" })).status).toBe(401);
  const viaHome = await say("hi", { "x-maipai-home-token": TOKEN, "content-type": "application/json" });
  expect(viaHome.status).toBe(403);
  expect(((await viaHome.json()) as { code: string }).code).toBe("admin_only");
  const confirmViaHome = await confirmCall("x", { action: "a", params: {} }, { "x-maipai-home-token": TOKEN, "content-type": "application/json" });
  expect(confirmViaHome.status).toBe(403);
});

test("a read question the model chooses runs the read tool and answers", async () => {
  setHelperModelForTests(scripted(call("get_roles", {}), text("Video and Chat are on.")));
  const body = await askJson("Could you describe what each of my capabilities is up to", await adminHeaders());
  expect(body.reply).toBe("Video and Chat are on.");
  expect(body.tools).toEqual(["get_roles"]);
  expect(body.pending).toEqual([]);
  expect(routeCalls[0]![1]).toBe("/stack/v1/roles");
});

test("a clear command becomes a card without asking the model: sentence, current to new value, nothing run, then one Confirm runs it and writes the audit line", async () => {
  setHelperModelForTests(NO_MODEL);
  const admin = await adminHeaders();
  const body = await askJson("turn video off", admin);
  expect(body.pending).toHaveLength(1);
  const card = body.pending[0]!;
  expect(card.action).toBe("set_role_enabled");
  expect(card.params).toEqual({ role: "video", enabled: false });
  expect(card.summary).toBe("Turn Video off");
  expect(card.changes).toEqual([{ label: "Video (video clips)", from: "on", to: "off" }]);
  expect(Date.parse(card.expires_at)).toBeGreaterThan(Date.now());
  expect(body.reply).toContain("Nothing has changed yet");
  expect(routeCalls.filter((c) => c[0] !== "GET")).toHaveLength(0);
  const done = await confirmCall(card.id, { action: card.action, params: card.params }, admin);
  expect(done.status).toBe(200);
  expect(routeCalls.filter((c) => c[0] !== "GET").map((c) => `${c[0]} ${c[1]}`)).toEqual(["PUT /stack/v1/settings", "POST /stack/v1/settings/apply"]);
  expect(routeCalls.find((c) => c[0] === "PUT")![2]).toEqual({ "stack.roles.video.enabled": false });
  const log = audits();
  expect(log.map((e) => e.event)).toEqual(["admin.action.helper.proposed", "admin.action.helper.approved"]);
  expect(log[1]!.source).toBe("helper");
  expect(log[1]!.approvedBy).toBe("admin");
  expect(log[1]!.action).toBe("set_role_enabled");
  // A second click on the same card does nothing.
  expect((await confirmCall(card.id, { action: card.action, params: card.params }, admin)).status).toBe(409);
  expect(routeCalls.filter((c) => c[0] === "PUT")).toHaveLength(1);
});

test("a change the model proposes goes through the same card, with a fixed sentence and the model's own words dropped", async () => {
  setHelperModelForTests(scripted(call("propose_action", { action: "set_role_priority", role: "music", above: "tts" }), text("ignored: the ask wording is fixed")));
  const body = await askJson("Make the thing that makes songs matter more than the talking one", await adminHeaders());
  expect(body.pending).toHaveLength(1);
  expect(body.pending[0]!.params).toEqual({ role: "music", priority: 99 });
  expect(body.pending[0]!.changes[0]).toMatchObject({ from: "100", to: "99" });
  expect(body.reply).toContain("Nothing has changed yet");
  expect(routeCalls.filter((c) => c[0] !== "GET")).toHaveLength(0);
});

test("Cancel drops the card and runs nothing; confirming it afterwards is refused", async () => {
  setHelperModelForTests(NO_MODEL);
  const admin = await adminHeaders();
  const card = (await askJson("restart the stack", admin)).pending[0]!;
  expect((await cancelCall(card.id, admin)).status).toBe(200);
  expect(routeCalls.filter((c) => c[0] !== "GET")).toHaveLength(0);
  const history = await (await fetch(`${base}/stack/v1/helper/history`, { headers: admin })).json() as { pending: unknown[]; messages: Array<{ content: string }> };
  expect(history.pending).toEqual([]);
  expect(history.messages.at(-1)!.content).toContain("did not do it");
  expect(audits().map((e) => e.event)).toEqual(["admin.action.helper.proposed", "admin.action.helper.denied"]);
  expect((await confirmCall(card.id, { action: card.action, params: card.params }, admin)).status).toBe(409);
  expect(routeCalls.filter((c) => c[0] !== "GET")).toHaveLength(0);
});

test("a tampered Confirm is rejected, nothing runs, the card is burned and the rejection is logged", async () => {
  setHelperModelForTests(NO_MODEL);
  const admin = await adminHeaders();
  const card = (await askJson("turn video off", admin)).pending[0]!;
  // The page, or anything pretending to be it, asks for something else under the same id.
  const edited = await confirmCall(card.id, { action: "set_role_enabled", params: { role: "chat", enabled: false } }, admin);
  expect(edited.status).toBe(409);
  expect(((await edited.json()) as { code: string }).code).toBe("edited");
  const otherAction = await confirmCall(card.id, { action: "restart_stack", params: {} }, admin);
  expect(otherAction.status).toBe(409);
  expect(routeCalls.filter((c) => c[0] !== "GET")).toHaveLength(0);
  expect(audits().map((e) => e.event)).toContain("admin.action.helper.rejected");
  // Even the honest Confirm is refused now: a rejected proposal is gone.
  expect((await confirmCall(card.id, { action: card.action, params: card.params }, admin)).status).toBe(409);
  expect(routeCalls.filter((c) => c[0] !== "GET")).toHaveLength(0);
});

test("an id that was never proposed, a cleared chat and an expired card are all refused", async () => {
  setHelperModelForTests(NO_MODEL);
  const admin = await adminHeaders();
  const never = await confirmCall(crypto.randomUUID(), { action: "restart_stack", params: {} }, admin);
  expect(never.status).toBe(404);
  expect(((await never.json()) as { code: string }).code).toBe("not_found");
  const cleared = (await askJson("restart the stack", admin)).pending[0]!;
  await fetch(`${base}/stack/v1/helper/history`, { method: "DELETE", headers: admin });
  expect((await confirmCall(cleared.id, { action: cleared.action, params: cleared.params }, admin)).status).toBe(404);
  const old = (await askJson("restart the stack", admin)).pending[0]!;
  __expireProposalForTests(old.id);
  const late = await confirmCall(old.id, { action: old.action, params: old.params }, admin);
  expect(late.status).toBe(410);
  expect(routeCalls.filter((c) => c[0] !== "GET")).toHaveLength(0);
});

test("an action that is not on the allow-list never becomes a card, even if the model asks for it", async () => {
  const admin = await adminHeaders();
  for (const action of ["reboot_host", "remove_model", "run_shell"]) {
    setHelperModelForTests(scripted(call("propose_action", { action }), text("I cannot do that.")));
    const body = await askJson(`Could you please handle number ${action} for me`, admin);
    expect(body.pending).toEqual([]);
  }
  expect(routeCalls.filter((c) => c[0] !== "GET")).toHaveLength(0);
});

test("admin, secret and unknown settings, unknown roles and the Helper's own switch are refused as proposals", async () => {
  const admin = await adminHeaders();
  const ask = async (args: Record<string, unknown>, m: string) => { setHelperModelForTests(scripted(call("propose_action", args), text("Not possible."))); return askJson(m, admin); };
  expect((await ask({ action: "set_setting", key: "stack.admin.allow_reboot", value: "true" }, "Allow the machine to be rebooted from this page, would you")).pending).toEqual([]);
  expect((await ask({ action: "set_setting", key: "nope.nothing", value: "1" }, "Adjust the nope nothing option for me")).pending).toEqual([]);
  expect((await ask({ action: "set_role_enabled", role: "root", enabled: true }, "Enable the root thing for me")).pending).toEqual([]);
  expect((await ask({ action: "set_role_enabled", role: "helper", enabled: false }, "Could you retire yourself from duty")).pending).toEqual([]);
  expect(routeCalls.filter((c) => c[0] !== "GET")).toHaveLength(0);
});

test("a change that is already so says so and offers no card", async () => {
  setHelperModelForTests(NO_MODEL);
  const body = await askJson("turn music off", await adminHeaders());
  expect(body.pending).toEqual([]);
  expect(body.reply).toContain("already off");
});

test("words that fit two features become one question and no card; nothing is guessed", async () => {
  setHelperModelForTests(NO_MODEL);
  const admin = await adminHeaders();
  for (const m of ["move music above speech", "restart the speech engine", "turn on the voice"]) {
    const body = await askJson(m, admin);
    expect(body.pending).toEqual([]);
    expect(body.reply).toContain("?");
    expect(body.reply).toMatch(/Voice in|Voice out/);
  }
});

test("reboot, removing a model and passwords are not offered and the reply points to the right screen", async () => {
  setHelperModelForTests(NO_MODEL);
  const admin = await adminHeaders();
  expect((await askJson("reboot the computer", admin)).reply).toContain("Tools screen");
  expect((await askJson("delete the coding model", admin)).reply).toContain("AI and models screen");
  expect((await askJson("what is my admin password", admin)).reply).toContain("cannot");
  expect(routeCalls).toHaveLength(0);
});

test("restart and profile proposals name what changes", async () => {
  setHelperModelForTests(NO_MODEL);
  const admin = await adminHeaders();
  const voice = (await askJson("restart the voice out engine", admin)).pending[0]!;
  expect(voice.params).toEqual({ name: "pocket-tts" });
  expect(voice.changes[0]).toMatchObject({ from: "not running", to: "restarted" });
  const profile = (await askJson("apply the recommended profile", admin)).pending[0]!;
  expect(profile.action).toBe("apply_profile");
  expect(profile.params).toEqual({ mode: "custom_recommended" });
  expect(profile.changes).toEqual([{ label: "Music", from: "off", to: "on" }, { label: "Video priority", from: "100", to: "50" }]);
  expect(profile.summary).toContain("137 GB");
  await confirmCall(profile.id, { action: profile.action, params: profile.params }, admin);
  expect(routeCalls.find((c) => c[1] === "/stack/v1/profiles/apply")![2]).toEqual({ mode: "custom_recommended" });
});

test("a failed change is reported, not hidden", async () => {
  setHelperRouteForTests(fakeRoute({ "POST /stack/v1/engines": { status: 409, json: { error: "not found" } } }));
  setHelperModelForTests(NO_MODEL);
  const admin = await adminHeaders();
  const card = (await askJson("restart llama-server", admin)).pending[0]!;
  const res = await confirmCall(card.id, { action: card.action, params: card.params }, admin);
  expect(res.status).toBe(502);
  expect(((await res.json()) as { error: string }).error).toContain("refused");
});

test("history is kept and the clear button empties it and drops what waits", async () => {
  setHelperModelForTests(NO_MODEL);
  const admin = await adminHeaders();
  await say("restart the stack", admin);
  const kept = await (await fetch(`${base}/stack/v1/helper/history`, { headers: admin })).json() as { messages: unknown[]; pending: unknown[] };
  expect(kept.messages).toHaveLength(2);
  expect(kept.pending).toHaveLength(1);
  expect((await fetch(`${base}/stack/v1/helper/history`, { method: "DELETE", headers: admin })).status).toBe(200);
  const cleared = await (await fetch(`${base}/stack/v1/helper/history`, { headers: admin })).json() as { messages: unknown[]; pending: unknown[] };
  expect(cleared.messages).toEqual([]);
  expect(cleared.pending).toEqual([]);
});

test("a model that cannot start gives a 503 sentence with a next step", async () => {
  setHelperModelForTests(async () => { throw new Error("not enough memory"); });
  const res = await say("Could you describe what each of my capabilities is up to", await adminHeaders());
  expect(res.status).toBe(503);
  expect(((await res.json()) as { error: string }).error).toContain("not enough memory");
});

test("status names the pinned model and says whether it is installed", async () => {
  const admin = await adminHeaders();
  const res = await fetch(`${base}/stack/v1/helper/status`, { headers: admin });
  expect(res.status).toBe(200);
  const body = await res.json() as { installed: boolean; keep_warm_minutes: number; model: { sha256: string; licence: string; revision: string } };
  expect(body.model.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(body.model.licence).toBe("Apache-2.0");
  expect(body.keep_warm_minutes).toBe(5);
  // Not on disk in the scratch data dir, so a real chat is refused with the install sentence.
  setHelperModelForTests(null);
  if (!body.installed) expect((await say("hi", admin)).status).toBe(409);
});

test("the page's own notices are not fed back to the model", async () => {
  const admin = await adminHeaders();
  setHelperModelForTests(NO_MODEL);
  await say("restart the stack", admin);
  let seen: Array<{ role: string; content: string }> = [];
  setHelperModelForTests(async (body) => { seen = body.messages as typeof seen; return text("Fine.") as never; });
  await say("Could you describe what each of my capabilities is up to", admin);
  const sent = seen.map((m) => m.content).join("\n");
  expect(sent).toContain("restart the stack");
  expect(sent).not.toContain("Nothing has changed yet");
});

test("the next short question leans on the last one: the model is told what the question before was about", async () => {
  const admin = await adminHeaders();
  setHelperModelForTests(scripted(text("Coding uses Qwen3.8 27B.")));
  await say("what are my coding models", admin);
  let system = "";
  let readCalls: string[] = [];
  setHelperModelForTests(async (body) => { const m = body.messages as Array<{ role: string; content: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> }>; system = m[0]!.content; readCalls = m.flatMap((x) => x.tool_calls ?? []).map((c) => `${c.function.name} ${c.function.arguments}`); return text("Coding has no Max tier.") as never; });
  await say("what about max", admin);
  expect(system).toContain("Coding");
  expect(system).toContain('"max" is a TIER name');
  expect(readCalls).toEqual(['get_models {"role":"coding","tier":"max"}']);
});

test("a read tool hands the model GB and never bytes, and says what an engine is", async () => {
  let toolText = "";
  setHelperModelForTests(async (body) => { const m = body.messages as Array<{ role: string; content: string }>; toolText = m.filter((x) => x.role === "tool").map((x) => x.content).join("\n"); return text("Splash is an engine and holds 25.1 GB.") as never; });
  const body = await askJson("why is splash taking so much memoru", await adminHeaders());
  expect(toolText).toContain("25.1 GB");
  expect(toolText).not.toMatch(/25062267288|25,062,267,288/);
  expect(toolText.toLowerCase()).toContain("engine");
  expect(body.reply).toContain("25.1 GB");
});

test("when the small model leaves out the one fact asked for, the Stack's own sentence is the answer", async () => {
  setHelperModelForTests(async () => text("It uses memory for a model and a cache.") as never);
  const body = await askJson("why is splash taking so much memoru", await adminHeaders());
  expect(body.reply).toMatch(/^Splash is an engine, not a model or a tier\. It is holding 25\.1 GB/);
  expect(body.reply).not.toContain("fancy");
  expect(body.reply).not.toContain("a model and a cache");
});

test("a number or model name the tools did not return is dropped from the answer", async () => {
  setHelperModelForTests(async () => text("Splash is an engine. It holds 99 GB. It also runs fancy-model-9-q4 for you. Lower the headroom setting.") as never);
  const body = await askJson("why is splash taking so much memoru", await adminHeaders());
  expect(body.reply).not.toContain("99 GB");
  expect(body.reply).not.toContain("fancy-model");
  expect(body.reply).toContain("25.1 GB");
  expect(body.dropped).toBe(2);
});

test("unit: grounding, cleaning and typed tool calls", () => {
  expect(groundReply("It is 25.3 GB. It is 40 GB.", "splash 25.1 GB").text).toBe("It is 25.3 GB.");
  expect(groundReply("Chat uses qwen3.8-27b-ud-q4-k-m.", "model qwen3.8-27b-ud-q4-k-m").dropped).toBe(0);
  expect(groundReply("Two things are on.", "nothing numeric").dropped).toBe(0);
  expect(cleanReply("Chat is fine. Use the get_settings function. It holds 25,062,267,288 bytes.", false, true)).toBe("Chat is fine.");
  expect(cleanReply("anything", true, false)).toContain("could not read");
  expect(salvageCalls('explain {"term": "splash"}')).toEqual([{ function: { name: "explain", arguments: { term: "splash" } } }]);
  expect(salvageCalls('<tool_call>{"name":"get_roles","arguments":{}}</tool_call>')[0]!.function.name).toBe("get_roles");
  expect(salvageCalls("Hello there")).toEqual([]);
  expect(salvageCalls('nothing_real {"a":1}')).toEqual([]);
});

test("a tool call typed as text is still run", async () => {
  setHelperModelForTests(scripted(text('explain {"term": "tier"}'), text("A tier is how big a model a feature may use.")));
  const body = await askJson("Could you describe what each of my capabilities is up to", await adminHeaders());
  expect(body.tools).toEqual(["explain"]);
  expect(body.reply).toContain("tier");
});

test("a tool error and a typed Looked at line never reach the answer", async () => {
  setHelperRouteForTests(fakeRoute({ "GET /stack/v1/roles": { status: 500, json: { error: "boom" } } }));
  setHelperModelForTests(scripted(call("get_roles", {}), text('The coding model is "qwen". Looked at: roles. for max  The setting "stack.engines.coding" does not exist. Use the get_settings function to view available settings.')));
  const body = await askJson("Could you describe what each of my capabilities is up to", await adminHeaders());
  expect(body.reply).toBe("I could not read that just now. Try again, or look on the Models or Settings screen.");
  expect(body.tools).toEqual([]);
});

test("a clean answer after a successful read drops leaked sentences and the footer text", async () => {
  setHelperModelForTests(scripted(call("get_roles", {}), text("Chat is ready. Looked at: roles. Use the get_settings function.")));
  const body = await askJson("Could you describe what each of my capabilities is up to", await adminHeaders());
  expect(body.reply).toBe("Chat is ready.");
});

test("get_settings with an invented prefix lists the real ones instead of inviting a guess", async () => {
  let toolText = "";
  setHelperModelForTests(async (body) => {
    const last = (body.messages as Array<{ role: string; content: string }>).at(-1)!;
    if (last.role === "tool") { toolText = last.content; return text("Could not tell.") as never; }
    return call("get_settings", { prefix: "stack.nonsense.zzz" }) as never;
  });
  await say("Could you describe what each of my capabilities is up to", await adminHeaders());
  expect(toolText).toContain("Real prefixes: stack.");
});
