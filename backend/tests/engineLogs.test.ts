import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { serveOptions } from "@/daemon";
import { __resetAdultViewForTests } from "@/lib/adultView";
import { __resetAdminAuthRateLimitsForTests, resetAdmin } from "@/lib/adminAuth";
import { dataDir } from "@/lib/paths";
import { ENGINE_LOG_LINES, __resetEngineLogsForTests, captureEngineOutput, engineLogLines, pushEngineLine, subscribeEngineLogs } from "@/lib/engineLogs";

const PROMPT = "Tell me where Grandma hides the spare key under the blue flowerpot";
const streamOf = (text: string) => new Response(text).body!;
beforeEach(() => __resetEngineLogsForTests());

test("a prompt string never appears in the buffer, in any of the shapes an engine echoes it", async () => {
  const dump = [
    `srv  log_server_r: request: {"model":"x","messages":[{"role":"user","content":"${PROMPT}"}]}`,
    `slot update_slots: id 0 | task 3 | prompt = ${PROMPT}`,
    `prompt: ${PROMPT}`,
    `{"prompt": "${PROMPT}", "n_predict": 64}`,
    `body: {"input":"${PROMPT}"}`,
    `    1234 -> '${PROMPT}'`,
    `request text='${PROMPT}'`,
    `slot update_slots: id 0 | task 3 | new prompt, n_ctx_slot = 8192, n_keep = 0, n_prompt_tokens = 14`,
  ].join("\n");
  const whole = await captureEngineOutput("chat", streamOf(dump));
  expect(whole).toContain(PROMPT); // the supervisor's exit evidence still sees the raw text; only the buffer is clean
  const stored = JSON.stringify(engineLogLines("chat"));
  expect(stored).not.toContain(PROMPT);
  expect(stored).not.toContain("Grandma");
  expect(stored).toContain("n_prompt_tokens = 14"); // ordinary diagnostics survive
});

test("tokens, keys and cookies are redacted before storing", () => {
  pushEngineLine("chat", "auth: Bearer abcdefghijklmnop1234 and api_key=sk-abcdefghijklmnopqrstuvwxyz");
  const stored = JSON.stringify(engineLogLines("chat"));
  expect(stored).not.toContain("abcdefghijklmnop1234");
  expect(stored).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
});

test("the ring keeps the newest lines per role and subscribers hear each redacted line", () => {
  const heard: string[] = [];
  const stop = subscribeEngineLogs((entry) => heard.push(entry.line));
  for (let i = 0; i < ENGINE_LOG_LINES + 25; i++) pushEngineLine("chat", `line ${i}`);
  pushEngineLine("stt", "other role");
  pushEngineLine("chat", `prompt: ${PROMPT}`);
  stop(); pushEngineLine("chat", "after unsubscribe");
  const chat = engineLogLines("chat", 1000);
  expect(chat).toHaveLength(ENGINE_LOG_LINES);
  expect(chat[0]!.line).toBe("line 27");
  expect(engineLogLines("stt")).toHaveLength(1);
  expect(heard.some((line) => line.includes(PROMPT))).toBe(false);
  expect(heard).not.toContain("after unsubscribe");
});

let server: ReturnType<typeof Bun.serve>;
let base = "";
const PASSWORD = "correct horse battery";
beforeAll(() => { __resetAdultViewForTests(); server = Bun.serve({ ...serveOptions(), port: 0 }); base = `http://127.0.0.1:${server.port}`; });
afterAll(async () => { server.stop(true); await resetAdmin(dataDir); __resetAdultViewForTests(); });
beforeEach(() => { __resetAdminAuthRateLimitsForTests(); });

test("the route needs an admin session: no cookie is refused, a signed-in admin reads the redacted lines", async () => {
  pushEngineLine("chat", `prompt: ${PROMPT}`);
  pushEngineLine("chat", "model loaded");
  expect((await fetch(`${base}/stack/v1/engine-logs`)).status).toBe(401);
  const code = await resetAdmin(dataDir);
  await fetch(`${base}/stack/v1/admin/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, password: PASSWORD }) });
  const login = await fetch(`${base}/stack/v1/admin/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  expect(cookie).toContain("stack_admin=");
  const res = await fetch(`${base}/stack/v1/engine-logs`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).not.toContain(PROMPT);
  expect(text).toContain("model loaded");
});
