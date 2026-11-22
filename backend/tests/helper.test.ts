// The Helper (HELPER-01): admin only, read tools run at once, every write waits
// for an Approve click, refusals for what it must never do. The model and the
// routes it calls are scripted; nothing here loads a model or restarts anything.
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { serveOptions } from "@/daemon";
import { __resetAdultViewForTests } from "@/lib/adultView";
import { __resetAdminAuthRateLimitsForTests, resetAdmin } from "@/lib/adminAuth";
import { __resetHelperForTests, refuseWrite, setHelperModelForTests, setHelperRouteForTests, type ModelCall } from "@/lib/helper";
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
  setHelperRouteForTests(async (method, path, body) => { routeCalls.push([method, path, body]); return { status: 200, json: path.includes("/roles") ? { roles: [{ id: "chat", enabled: true, priority: 100, state: { state: "ready" }, model: { id: "m" } }] } : { ok: true } }; });
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
const say = (message: string, headers: Record<string, string>) => fetch(`${base}/stack/v1/helper/chat`, { method: "POST", headers, body: JSON.stringify({ message }) });
const call = (name: string, args: Record<string, unknown>) => ({ message: { content: "", tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } });
const text = (content: string) => ({ message: { content } });
/** A model that plays the given answers in order. */
const scripted = (...answers: Array<ReturnType<typeof call> | ReturnType<typeof text>>): ModelCall => { let i = 0; return async () => answers[Math.min(i++, answers.length - 1)] as never; };

test("the Helper is its own role: not on /v1, no Home route, loads on demand", () => {
  expect(ROLES.helper.residency).toBe("jit");
  expect(ROLES.helper.endpoints).toEqual([]);
});

test("the tool list has no way to reboot, edit files, run commands or read secrets", () => {
  const names = HELPER_TOOLS.map((t) => t.name).join(" ");
  expect(names).not.toMatch(/reboot|shell|exec|file|password|token|secret/);
  expect(HELPER_TOOLS.filter((t) => t.kind === "write").map((t) => t.name).sort()).toEqual(["apply_update", "check_updates", "restart_engine", "restart_stack", "rollback_update", "set_role_enabled", "set_setting"]);
});

test("no sign-in and Home's token are both refused", async () => {
  setHelperModelForTests(scripted(text("hi")));
  expect((await say("hi", { "content-type": "application/json" })).status).toBe(401);
  const viaHome = await say("hi", { "x-maipai-home-token": TOKEN, "content-type": "application/json" });
  expect(viaHome.status).toBe(403);
  expect(((await viaHome.json()) as { code: string }).code).toBe("admin_only");
});

test("a read question runs the read tool at once and answers", async () => {
  setHelperModelForTests(scripted(call("get_roles", {}), text("Chat is ready.")));
  const res = await say("Why is chat offline?", await adminHeaders());
  expect(res.status).toBe(200);
  const body = await res.json() as { reply: string; tools: string[]; pending: unknown[] };
  expect(body.reply).toBe("Chat is ready.");
  expect(body.tools).toEqual(["get_roles"]);
  expect(body.pending).toEqual([]);
  expect(routeCalls[0]![1]).toBe("/stack/v1/roles");
});

test("a write is parked until Approve: nothing runs on the ask, it runs once on approve, and the audit line names Helper and admin", async () => {
  setHelperModelForTests(scripted(call("set_role_enabled", { role: "video", enabled: false }), text("ignored: the ask wording is fixed")));
  const admin = await adminHeaders();
  const body = await (await say("Turn off video", admin)).json() as { reply: string; pending: Array<{ id: string; summary: string }> };
  expect(body.pending).toHaveLength(1);
  expect(body.pending[0]!.summary).toBe("Turn video off");
  expect(((body as unknown) as { reply: string }).reply).toContain("Nothing has changed yet");
  expect(routeCalls).toHaveLength(0);
  const approved = await fetch(`${base}/stack/v1/helper/approvals/${body.pending[0]!.id}/approve`, { method: "POST", headers: admin });
  expect(approved.status).toBe(200);
  expect(routeCalls.map((c) => `${c[0]} ${c[1]}`)).toEqual(["PUT /stack/v1/settings", "POST /stack/v1/settings/apply"]);
  expect(routeCalls[0]![2]).toEqual({ "stack.roles.video.enabled": false });
  const audit = lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, string>).find((e) => e.event === "admin.action.helper.approved")!;
  expect(audit.source).toBe("helper");
  expect(audit.approvedBy).toBe("admin");
  // A second click on the same id finds nothing.
  expect((await fetch(`${base}/stack/v1/helper/approvals/${body.pending[0]!.id}/approve`, { method: "POST", headers: admin })).status).toBe(404);
});

test("Deny drops the change and runs nothing", async () => {
  setHelperModelForTests(scripted(call("restart_stack", {}), text("Say the word.")));
  const admin = await adminHeaders();
  const body = await (await say("restart", admin)).json() as { pending: Array<{ id: string }> };
  expect((await fetch(`${base}/stack/v1/helper/approvals/${body.pending[0]!.id}/deny`, { method: "POST", headers: admin })).status).toBe(200);
  expect(routeCalls).toHaveLength(0);
  const history = await (await fetch(`${base}/stack/v1/helper/history`, { headers: admin })).json() as { pending: unknown[]; messages: Array<{ content: string }> };
  expect(history.pending).toEqual([]);
  expect(history.messages.at(-1)!.content).toContain("did not do it");
});

test("the Helper cannot change admin settings, unknown roles or unknown settings, even if the model asks", async () => {
  expect(refuseWrite("set_setting", { key: "stack.admin.allow_reboot", value: "true" })).toContain("may not change");
  expect(refuseWrite("set_setting", { key: "nope.nothing", value: "1" })).toContain("no setting");
  expect(refuseWrite("set_role_enabled", { role: "root", enabled: true })).toContain("no role");
  setHelperModelForTests(scripted(call("set_setting", { key: "stack.admin.allow_reboot", value: "true" }), text("I am not allowed to change that.")));
  const body = await (await say("allow reboot", await adminHeaders())).json() as { pending: unknown[] };
  expect(body.pending).toEqual([]);
  expect(routeCalls).toHaveLength(0);
});

test("a failed change is reported, not hidden", async () => {
  setHelperRouteForTests(async () => ({ status: 409, json: { error: "not found" } }));
  setHelperModelForTests(scripted(call("restart_engine", { name: "llama-server" }), text("ok")));
  const admin = await adminHeaders();
  const body = await (await say("restart llama", admin)).json() as { pending: Array<{ id: string }> };
  const res = await fetch(`${base}/stack/v1/helper/approvals/${body.pending[0]!.id}/approve`, { method: "POST", headers: admin });
  expect(res.status).toBe(502);
  expect(((await res.json()) as { error: string }).error).toContain("refused");
});

test("history is kept and the clear button empties it and drops what waits", async () => {
  setHelperModelForTests(scripted(call("restart_stack", {}), text("Approve to restart.")));
  const admin = await adminHeaders();
  await say("restart", admin);
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
  const res = await say("hi", await adminHeaders());
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
  let seen: Array<{ role: string; content: string }> = [];
  setHelperModelForTests(async (body) => { seen = body.messages as typeof seen; return text("Fine.") as never; });
  const admin = await adminHeaders();
  setHelperModelForTests(scripted(call("restart_stack", {}), text("x")));
  await say("restart", admin);
  setHelperModelForTests(async (body) => { seen = body.messages as typeof seen; return text("Fine.") as never; });
  await say("how is memory?", admin);
  const sent = seen.map((m) => m.content).join("\n");
  expect(sent).toContain("restart");
  expect(sent).not.toContain("I need your approval");
});

// Regression (2026-11-21): "what's my coding model" answered with an invented key,
// a raw tool error, "Looked at: roles. for max" and a guessed model name.
test("a role-model question is answered from the roles route, with the real model id", async () => {
  setHelperRouteForTests(async (method, path) => { routeCalls.push([method, path, undefined]); return { status: 200, json: { roles: [{ id: "coding", enabled: true, state: { state: "installed" }, model: { id: "real-coding-model" } }] } }; });
  let toolText = "";
  const model: ModelCall = async (body) => {
    const msgs = body.messages as Array<{ role: string; content: string }>;
    const last = msgs[msgs.length - 1]!;
    if (last.role === "tool") { toolText = last.content; return text("Your coding model is real-coding-model.") as never; }
    return call("get_role_model", { role: "coding" }) as never;
  };
  setHelperModelForTests(model);
  const body = await (await say("what's my coding model", await adminHeaders())).json() as { reply: string; tools: string[] };
  expect(toolText).toContain("real-coding-model");
  expect(routeCalls[0]![1]).toBe("/stack/v1/roles");
  expect(body.reply).toBe("Your coding model is real-coding-model.");
  expect(body.tools).toEqual(["get_role_model"]);
});

test("get_settings with an invented prefix lists the real ones instead of inviting a guess", async () => {
  expect(HELPER_TOOLS.find((t) => t.name === "get_settings")!.parameters.properties.prefix!.description).not.toContain("stack.engines.coding");
  let toolText = "";
  setHelperModelForTests(async (body) => {
    const last = (body.messages as Array<{ role: string; content: string }>).at(-1)!;
    if (last.role === "tool") { toolText = last.content; return text("Could not tell.") as never; }
    return call("get_settings", { prefix: "stack.nonsense.zzz" }) as never;
  });
  await say("x", await adminHeaders());
  expect(toolText).toContain("Real prefixes: stack.");
});

test("a tool error and a typed Looked at line never reach the answer", async () => {
  setHelperRouteForTests(async () => ({ status: 500, json: { error: "boom" } }));
  setHelperModelForTests(scripted(call("get_roles", {}), text('The coding model is "qwen". Looked at: roles. for max  The setting "stack.engines.coding" does not exist. Use the get_settings function to view available settings.')));
  const body = await (await say("what's my coding model", await adminHeaders())).json() as { reply: string; tools: string[] };
  expect(body.reply).toBe("I could not read that just now. Try again, or look on the Models or Settings screen.");
  expect(body.tools).toEqual([]);
});

test("a clean answer after a successful read drops leaked sentences and the footer text", async () => {
  setHelperModelForTests(scripted(call("get_roles", {}), text("Chat is ready. Looked at: roles. Use the get_settings function.")));
  const body = await (await say("status", await adminHeaders())).json() as { reply: string };
  expect(body.reply).toBe("Chat is ready.");
});
