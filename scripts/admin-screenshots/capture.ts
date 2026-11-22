// Takes the admin page screenshots: every screen, desktop and phone width, light and dark.
// Run it through scripts/make-admin-screenshots.sh. It
//   1. starts a scratch Stack (its own data folder and a free port, never the live Stack),
//   2. makes the admin account through the real setup route and signs in,
//   3. drives Google Chrome (headless, no libraries) and, in the browser only,
//      swaps the answers that would show this computer's own state for the demo
//      data in fixtures.ts,
//   4. writes docs/images/admin/<screen>-<desktop|phone>-<light|dark>.webp.
// Open each image and judge it before it goes into a page (docs/STYLE.md).
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as demo from "./fixtures";

const root = resolve(import.meta.dir, "../..");
const outDir = resolve(process.env.SHOTS_OUT ?? join(root, "docs/images/admin"));
const only = process.env.SHOTS_ONLY?.split(",").filter(Boolean);
const CHROME = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PASSWORD = "demo-admin-password-1";
const THEME_KEY = "maipai.stack.admin.theme";

const SCREENS = [
  { id: "sign-in", hash: "", wait: 600 }, { id: "overview", hash: "overview", wait: 1200 }, { id: "features", hash: "features", wait: 1200 },
  { id: "models", hash: "models", wait: 1800 }, { id: "resources", hash: "resources", wait: 2600 }, { id: "engines", hash: "engines", wait: 1400 },
  { id: "health", hash: "health", wait: 1200 }, { id: "settings", hash: "settings", wait: 1500 }, { id: "updates", hash: "updates", wait: 1200 },
  { id: "tools", hash: "tools", wait: 1400 }, { id: "helper", hash: "helper", wait: 1500 },
  // The Helper slide-over, opened from the top bar on the Overview.
  { id: "helper-panel", hash: "overview", wait: 1200, open: `document.querySelector('[aria-keyshortcuts="Control+/ Meta+/"]').click()` },
  // The command palette, opened with its top-bar search box.
  { id: "palette", hash: "overview", wait: 1200, open: `document.querySelector('button.search-field, header button[aria-label^="Search"]').click()` },
].filter((s) => !only || only.includes(s.id));
const SIZES = [{ id: "desktop", width: 1280, height: 800, cap: 1600, mobile: false }, { id: "phone", width: 375, height: 812, cap: 2600, mobile: true }];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const children: ChildProcess[] = [];
function stopAll() { for (const c of children) { try { c.kill("SIGTERM"); } catch { /* already gone */ } } }
process.on("exit", stopAll);
process.on("SIGINT", () => { stopAll(); process.exit(130); });

async function freePort(): Promise<number> {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = s.port; s.stop(true); return p;
}

// ---- The scratch Stack ------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "stack-shots-"));
const dataDir = join(scratch, "data");
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
if (!existsSync(join(root, "admin-ui/dist/index.html"))) throw new Error("The admin page is not built. Run: cd admin-ui && bun run build");
mkdirSync(dataDir, { recursive: true });
const stack = spawn("bun", ["run", "src/index.ts"], { cwd: join(root, "backend"), env: { ...process.env, STACK_DATA_DIR: dataDir, PORT: String(port) }, stdio: "ignore" });
children.push(stack);
for (let i = 0; i < 120; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not up yet */ } await sleep(500); }
const headers = { "content-type": "application/json", "x-stack-admin": "1", origin: base };
const code = (await Bun.file(join(dataDir, "admin-setup-code")).text()).trim();
await fetch(`${base}/stack/v1/admin/setup`, { method: "POST", headers, body: JSON.stringify({ code, password: PASSWORD }) }).then((r) => { if (!r.ok) throw new Error(`setup answered ${r.status}`); });
const login = await fetch(`${base}/stack/v1/admin/login`, { method: "POST", headers, body: JSON.stringify({ password: PASSWORD }) });
if (!login.ok) throw new Error(`sign-in answered ${login.status}`);
const token = /stack_admin=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
if (!token) throw new Error("The sign-in gave no session cookie.");
// Seeded for real, through the settings routes: update checks on, so Settings and Updates agree.
const authed = { ...headers, cookie: `stack_admin=${token}` };
await fetch(`${base}/stack/v1/settings`, { method: "PUT", headers: authed, body: JSON.stringify({ "stack.updates.enabled": true }) }).then((r) => { if (!r.ok) throw new Error(`settings answered ${r.status}`); });
await fetch(`${base}/stack/v1/settings/apply`, { method: "POST", headers: authed, body: "{}" });
const real = async (path: string): Promise<Record<string, unknown>> => (await fetch(`${base}${path}`, { headers: { cookie: `stack_admin=${token}` } })).json() as Promise<Record<string, unknown>>;
const totalBytes = ((await real("/stack/v1/status")).memory as { total_bytes: number }).total_bytes;

// What the page asks for that the demo replaces. Everything else goes to the scratch Stack.
const overrides: Record<string, (url: URL) => Promise<unknown>> = {
  "/healthz": async () => demo.healthzDemo(await real("/healthz")),
  "/stack/v1/status": async () => demo.patchStatus(await real("/stack/v1/status")),
  "/stack/v1/roles": async () => demo.patchRoles((await real("/stack/v1/roles")) as { roles: Record<string, unknown>[] }),
  "/stack/v1/health": async () => demo.healthDemo(),
  "/stack/v1/engines": async () => demo.patchEngines((await real("/stack/v1/engines")) as { engines: Record<string, unknown>[] }),
  "/stack/v1/logs": async () => demo.logsDemo(),
  "/stack/v1/updates": async () => demo.updatesDemo(),
  "/stack/v1/models": async () => demo.modelsDemo(),
  "/stack/v1/check/latest": async () => demo.readinessDemo(),
  "/stack/v1/helper/status": async () => demo.patchHelperStatus(await real("/stack/v1/helper/status")),
  "/stack/v1/helper/history": async () => demo.helperHistoryDemo(),
  "/stack/v1/resources/summary": async () => demo.summaryDemo(totalBytes),
  "/stack/v1/resources/history": async (u) => demo.historyDemo((u.searchParams.get("range") ?? "1h") as "1h" | "24h" | "7d", totalBytes),
};

// ---- Chrome over the DevTools protocol --------------------------------------

const chromePort = await freePort();
const profile = join(scratch, "chrome");
const chrome = spawn(CHROME, [`--remote-debugging-port=${chromePort}`, `--user-data-dir=${profile}`, "--headless=new", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--disable-gpu", "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
children.push(chrome);
let wsUrl = "";
for (let i = 0; i < 60 && !wsUrl; i++) {
  try {
    const tab = await fetch(`http://127.0.0.1:${chromePort}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json() as Promise<{ webSocketDebuggerUrl: string }>);
    wsUrl = tab.webSocketDebuggerUrl;
  } catch { await sleep(500); }
}
if (!wsUrl) throw new Error(`Chrome did not start (${CHROME}). Set CHROME_BIN to a Chrome or Chromium binary.`);
const ws = new WebSocket(wsUrl);
await new Promise<void>((ok, bad) => { ws.onopen = () => ok(); ws.onerror = () => bad(new Error("Could not connect to Chrome.")); });
let nextId = 1;
const pending = new Map<number, { ok: (v: unknown) => void; bad: (e: Error) => void }>();
const listeners: ((method: string, params: Record<string, unknown>) => void)[] = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown> };
  if (msg.id !== undefined) { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p?.bad(new Error(msg.error.message)); else p?.ok(msg.result); }
  else if (msg.method) for (const l of listeners) l(msg.method, msg.params ?? {});
};
const cdp = <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}) => new Promise<T>((ok, bad) => {
  const id = nextId++; pending.set(id, { ok: ok as (v: unknown) => void, bad }); ws.send(JSON.stringify({ id, method, params }));
});

listeners.push((method, params) => {
  if (method !== "Fetch.requestPaused") return;
  const requestId = String(params.requestId);
  const url = new URL(String((params.request as { url: string }).url));
  const handler = (params.request as { method: string }).method === "GET" ? overrides[url.pathname] : undefined;
  if (!handler) { void cdp("Fetch.continueRequest", { requestId }).catch(() => {}); return; }
  void handler(url).then(
    (body) => cdp("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }, { name: "cache-control", value: "no-store" }], body: Buffer.from(JSON.stringify(body)).toString("base64") }),
    () => cdp("Fetch.continueRequest", { requestId }),
  ).catch(() => {});
});

await cdp("Page.enable");
await cdp("Network.enable");
await cdp("Fetch.enable", { patterns: [{ urlPattern: `${base}/stack/v1/*` }, { urlPattern: `${base}/healthz` }] });
await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
const evaluate = (expression: string) => cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
async function load(url: string) { await cdp("Page.navigate", { url }); await sleep(400); }

async function shoot(file: string, size: (typeof SIZES)[number]) {
  await cdp("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile });
  await sleep(300);
  const height = Number(((await evaluate("Math.ceil(document.documentElement.scrollHeight)")) as { result: { value: number } }).result.value);
  const h = Math.min(Math.max(size.height, height), size.cap);
  await cdp("Emulation.setDeviceMetricsOverride", { width: size.width, height: h, deviceScaleFactor: 1, mobile: size.mobile });
  await sleep(500);
  const shot = await cdp<{ data: string }>("Page.captureScreenshot", { format: "webp", quality: 82, captureBeyondViewport: false });
  writeFileSync(file, Buffer.from(shot.data, "base64"));
}

mkdirSync(outDir, { recursive: true });
let count = 0;
try {
  for (const size of SIZES) {
    for (const theme of ["light", "dark"] as const) {
      await cdp("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile });
      await cdp("Network.deleteCookies", { name: "stack_admin", url: base });
      await load(`${base}/admin/`);
      await evaluate(`localStorage.setItem(${JSON.stringify(THEME_KEY)}, ${JSON.stringify(theme)})`);
      for (const screen of SCREENS) {
        if (screen.id === "sign-in") {
          await cdp("Network.deleteCookies", { name: "stack_admin", url: base });
          await load(`${base}/admin/`); await sleep(screen.wait);
        } else {
          await cdp("Network.setCookie", { name: "stack_admin", value: token, url: base, httpOnly: true, sameSite: "Strict" });
          await load(`${base}/admin/#/${screen.hash}`);
          await evaluate("location.reload()"); await sleep(screen.wait);
          if ("open" in screen && screen.open) { await evaluate(screen.open); await sleep(900); }
        }
        const file = join(outDir, `${screen.id}-${size.id}-${theme}.webp`);
        await shoot(file, size);
        count++;
        console.log(`wrote ${file}`);
      }
    }
  }
  console.log(`${count} screenshots in ${outDir}. Open each one and judge it before using it.`);
} finally {
  try { ws.close(); } catch { /* closed */ }
  stopAll();
  await sleep(800);
  rmSync(scratch, { recursive: true, force: true });
}
