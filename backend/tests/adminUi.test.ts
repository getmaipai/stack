// The admin page's static files: served at /admin from the Stack's own app,
// behind the loopback guard, no session needed for the shell (the data it
// reads is behind the sign-in), and nothing outside its folder is readable.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveOptions } from "@/daemon";
import { guardAdminAware } from "@/lib/adminGuard";
import { adminUiDir } from "@/lib/adminUi";

let server: ReturnType<typeof Bun.serve>;
let base = "";
let root = "";
let outside = "";
const previous = process.env.STACK_ADMIN_UI_DIR;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "stack-admin-ui-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>MaiPai Stack admin</title><div id=root></div>");
  writeFileSync(join(root, "assets", "app-abc123.js"), "console.log('admin');");
  outside = join(root, "..", `stack-admin-outside-${process.pid}.txt`);
  writeFileSync(outside, "secret");
  process.env.STACK_ADMIN_UI_DIR = root;
  server = Bun.serve({ ...serveOptions(), port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { force: true });
  if (previous === undefined) delete process.env.STACK_ADMIN_UI_DIR; else process.env.STACK_ADMIN_UI_DIR = previous;
});

test("/admin redirects to /admin/, which serves the page without a session", async () => {
  const redirect = await fetch(`${base}/admin`, { redirect: "manual" });
  expect(redirect.status).toBe(308);
  expect(redirect.headers.get("location")).toBe("/admin/");
  const page = await fetch(`${base}/admin/`);
  expect(page.status).toBe(200);
  expect(page.headers.get("cache-control")).toBe("no-cache");
  expect(page.headers.get("x-frame-options")).toBe("DENY");
  expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
  expect(await page.text()).toContain("MaiPai Stack admin");
});

test("hashed assets are served as immutable files with the right type", async () => {
  const asset = await fetch(`${base}/admin/assets/app-abc123.js`);
  expect(asset.status).toBe(200);
  expect(asset.headers.get("cache-control")).toContain("immutable");
  expect(asset.headers.get("content-type")).toContain("javascript");
  expect((await fetch(`${base}/admin/assets/missing.js`)).status).toBe(404);
});

test("nothing outside the page folder is readable, and a sibling name is not the admin page", async () => {
  const climb = await fetch(`${base}/admin/%2e%2e/${outside.split("/").pop()}`);
  expect(climb.status).toBe(404);
  expect(await climb.text()).not.toContain("secret");
  expect((await fetch(`${base}/admin/..%2f..%2fpackage.json`)).status).toBe(404);
  expect((await fetch(`${base}/administrator`)).status).toBe(404);
});

test("the sign-in stays required for the data: /stack/v1 reads still need Home's token or a session on a write, and the page is GET only", async () => {
  const write = await fetch(`${base}/admin/`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect([401, 404, 405]).toContain(write.status);
  const login = await fetch(`${base}/stack/v1/admin/session`);
  expect(login.status).toBe(401);
});

test("a host that is not loopback is refused even for the page", async () => {
  const response = await fetch(`${base}/admin/`, { headers: { host: "evil.example.com" } });
  expect(response.status).toBe(421);
});

test("a missing build answers 503 with the fix, not a blank page", async () => {
  const keep = process.env.STACK_ADMIN_UI_DIR;
  process.env.STACK_ADMIN_UI_DIR = join(root, "does-not-exist");
  const response = await fetch(`${base}/admin/`);
  expect(response.status).toBe(503);
  expect(((await response.json()) as { code: string }).code).toBe("admin_ui_missing");
  process.env.STACK_ADMIN_UI_DIR = keep;
});

test("on the Tailscale listener the page is GET only; its data still needs a session", async () => {
  const ip = "100.101.102.103";
  const mode = { tailscaleAddress: ip };
  const req = (path: string, init: RequestInit = {}) => new Request(`http://${ip}:8770${path}`, { ...init, headers: { host: `${ip}:8770`, ...(init.headers as Record<string, string> | undefined) } });
  expect(await guardAdminAware(req("/admin/"), mode)).toBeNull();
  expect(await guardAdminAware(req("/admin/assets/app.js"), mode)).toBeNull();
  expect((await guardAdminAware(req("/admin/", { method: "POST", headers: { "content-type": "application/json" } }), mode))!.status).toBe(404);
  expect((await guardAdminAware(req("/stack/v1/status"), mode))!.status).toBe(401);
});

test("the default folder is the repo's admin-ui/dist for a source run", () => {
  delete process.env.STACK_ADMIN_UI_DIR;
  expect(adminUiDir().endsWith("/admin-ui/dist")).toBe(true);
  process.env.STACK_ADMIN_UI_DIR = root;
});
