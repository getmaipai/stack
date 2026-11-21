// The admin page's files: the static single-page app built from admin-ui/
// (Vite, @maipai/ui), served at /admin by the Stack itself. The page is only
// a shell: every number on it comes from /stack/v1/* behind the admin
// sign-in (lib/adminGuard.ts), so serving the shell needs no session. Who
// may reach it is decided in front of the app like every other route
// (loopback Host and Origin checks; on the Tailscale listener GET only).
//
// Where the files are: `admin-ui/dist` in the repo for a source run, an
// `admin-ui/` folder beside the binary for a compiled build
// (scripts/build-binary.sh copies it, for the same reason migrations are a
// sibling folder: a compiled binary cannot serve from its own virtual
// filesystem with plain node:fs). STACK_ADMIN_UI_DIR overrides both (tests).
import { existsSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { isCompiledBinary } from "@/lib/paths";

export const ADMIN_UI_PREFIX = "/admin";

export function adminUiDir(): string {
  const override = process.env.STACK_ADMIN_UI_DIR;
  if (override) return resolve(override);
  return isCompiledBinary ? join(dirname(process.execPath), "admin-ui") : resolve(import.meta.dir, "../../../admin-ui/dist");
}

/** Whether a path belongs to the admin page (`/admin` or `/admin/...`, never `/administrator`). */
export function isAdminUiPath(path: string): boolean {
  return path === ADMIN_UI_PREFIX || path.startsWith(`${ADMIN_UI_PREFIX}/`);
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function notBuilt(): Response {
  return new Response(JSON.stringify({ error: "The admin page is not built on this computer. Run `bun run build:admin` in the Stack folder (or reinstall the Stack), then reload.", code: "admin_ui_missing" }), {
    status: 503, headers: { "content-type": "application/json", "cache-control": "no-store", ...SECURITY_HEADERS },
  });
}

/** The response for GET/HEAD of an admin page path. `/admin` redirects to `/admin/`. */
export function serveAdminUi(path: string): Response {
  if (path === ADMIN_UI_PREFIX) return new Response(null, { status: 308, headers: { location: `${ADMIN_UI_PREFIX}/`, ...SECURITY_HEADERS } });
  const root = adminUiDir();
  const index = join(root, "index.html");
  if (!existsSync(index)) return notBuilt();
  let relative: string;
  try { relative = decodeURIComponent(path.slice(ADMIN_UI_PREFIX.length + 1)); } catch { return new Response("Not found", { status: 404, headers: SECURITY_HEADERS }); }
  if (relative === "") relative = "index.html";
  const file = normalize(join(root, relative));
  if (file !== root && !file.startsWith(root + sep)) return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
  let ok = false;
  try { ok = statSync(file).isFile(); } catch { /* missing */ }
  if (!ok) return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
  const immutable = relative.startsWith("assets/");
  return new Response(Bun.file(file), { status: 200, headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache", ...SECURITY_HEADERS } });
}
