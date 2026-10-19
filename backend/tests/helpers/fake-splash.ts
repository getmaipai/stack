// A stand-in for Splash's process tree (CODE-STACK-01 S5a), run by the suite
// instead of the real engine: no model is ever loaded. It is started the way the
// Stack starts Splash (`python3 -u launcher.py serve --model ... --port N ...`, where
// the test's `python3` is a shell script that runs this file), becomes an HTTP server
// on the given port, and starts one child (`sleep`) the way Splash's server starts its
// native engine. What it was given (arguments, a few environment values, the child's pid)
// is written to <TMPDIR>/fake-splash.json for the test to read back.
//
// Behaviours, chosen by environment values the test sets:
//   FAKE_SPLASH_REFUSE=1      exit with an error before listening (a Splash that cannot start)
//   FAKE_SPLASH_WRONG_NAME=1  list a different served model name than the one asked for
//   FAKE_SPLASH_NOT_SPLASH=1  list the right name but not as owned by splash
import { writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const serveAt = argv.indexOf("serve");
const args = serveAt === -1 ? [] : argv.slice(serveAt + 1);
const flag = (name: string): string | undefined => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
const port = Number(flag("--port"));
const served = flag("--served-model-name") ?? "unknown";
const tmp = process.env.TMPDIR ?? "/tmp";

if (process.env.FAKE_SPLASH_REFUSE === "1") { console.error("cannot start: the model could not be assembled"); process.exit(3); }

// The native engine: a child that does the work. Splash's server is its parent.
const child = Bun.spawn(["sleep", "600"], { stdout: "ignore", stderr: "ignore" });

writeFileSync(join(tmp, "fake-splash.json"), JSON.stringify({
  pid: process.pid,
  childPid: child.pid,
  argv: args,
  env: Object.fromEntries(["HOME", "HF_HOME", "HF_HUB_CACHE", "HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY", "DO_NOT_TRACK", "TMPDIR", "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "STACK_SECRETS_KEY", "PYTHONPATH", "SPLASH_API_KEY"].map((key) => [key, process.env[key] ?? null])),
}));

const shutdown = () => { try { child.kill(); } catch { /* gone */ } process.exit(0); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ status: "ok" });
    if (url.pathname === "/ready") return Response.json({ status: "ready" });
    if (url.pathname === "/v1/models") {
      const id = process.env.FAKE_SPLASH_WRONG_NAME === "1" ? "something-else" : served;
      return Response.json({ object: "list", data: [{ id, object: "model", owned_by: process.env.FAKE_SPLASH_NOT_SPLASH === "1" ? "someone" : "splash", context_length: 131072 }] });
    }
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { model?: unknown };
      appendFileSync(join(tmp, "fake-splash-requests.log"), `${JSON.stringify({ path: url.pathname, model: body.model ?? null })}\n`);
      // Splash answers 404 to a model name it does not serve.
      if (body.model !== undefined && body.model !== served) return Response.json({ error: { message: "model not found", code: "model_not_found" } }, { status: 404 });
      if (url.pathname === "/v1/chat/completions") return Response.json({ id: "chatcmpl-1", object: "chat.completion", model: served, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },
});
