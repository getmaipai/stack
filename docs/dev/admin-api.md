# The admin page and its API

The admin page is a static single-page app (`admin-ui/`: Vite, React 19, the `@maipai/ui` kit) that the Stack serves at `/admin/`. It holds no logic of its own. Every number on it comes from `/stack/v1/*`, the same routes Home calls, so nothing here is a second definition. The generated reference is [docs/api/openapi.json](../api/openapi.json). The role routes and the contract Home builds against are in [integrations.md](../integrations.md); the design record is [dev.md](../dev.md); the plan this came from is [plans/admin-and-standalone-2026-11-21.md](../plans/admin-and-standalone-2026-11-21.md).

## Who may call

Two callers, checked in front of the routes (`backend/src/lib/adminGuard.ts`):

- **Home** sends its token. Its path is unchanged: loopback Host and Origin checks, then the token on every write.
- **An admin** sends the `stack_admin` session cookie. The cookie is accepted in place of Home's token on `/stack/v1/*`. A write with a cookie must also carry `x-stack-admin: 1` and an `Origin` equal to the `Host`, so a page on another site cannot ride the cookie.

The listener is loopback only. When the setting `stack.admin.tailscale` is on (default off, needs a restart), a second listener binds the computer's Tailscale address (`100.64.0.0/10`, never `0.0.0.0` or a home-network address). On that listener every `/stack/v1/*` request needs an admin session, except `/healthz`, the sign-in routes and the session probe, and Home's token is not accepted at all.

## Sign-in

| Route | What it does |
|---|---|
| `POST /stack/v1/admin/setup` | First run. Body `{ code, password }`. The code is the one in `<data>/admin-setup-code` (mode 0600, also in the log). Password at least 8 characters, stored as an argon2id hash. 5 tries per hour. Deletes the code file. |
| `POST /stack/v1/admin/login` | Body `{ password }`. Sets `stack_admin` (HttpOnly, SameSite=Strict, Path=/). 5 wrong tries in 15 minutes answers 429 with `retry_after`. |
| `POST /stack/v1/admin/logout` | Ends the session. |
| `POST /stack/v1/admin/password` | Body `{ current, new }`. Ends every other session. |
| `GET /stack/v1/admin/session` | `{ signed_in, expires_at }` or 401. A session lasts 12 hours at most and ends after 30 idle minutes. |

There is no read that says whether an admin exists: the page tries to sign in and switches to setup on the 409 `no_admin`. Reset is local only: `maipai-stack admin reset` (with `STACK_DATA_DIR` set) removes the account and every session and writes a new setup code. Every setup, sign-in and failure is a line in the log with time and remote address, never a password or code.

## Routes the page uses

| Screen | Routes |
|---|---|
| Overview, Health, Engines | `GET /healthz`, `GET /stack/v1/status`, `/roles`, `/health`, `/engines`, `/logs?tail=`; `POST /health/{code}/fix`, `/engines/{name}/restart`; the SSE feed `GET /stack/v1/events` |
| Resources | `GET /stack/v1/resources/summary`, `/resources/history?range=1h\|24h\|7d` |
| Features | `PUT /stack/v1/settings` with `stack.roles.<role>.enabled` and `.priority` |
| Models | `POST /stack/v1/profiles/recommend`, `/profiles/apply`; `GET /models/catalog`, `/models`; `POST /models`; `DELETE /models/{id}` |
| Settings | `GET /stack/v1/settings`, `PUT /settings`, `POST /settings/apply` |
| Updates | `GET /stack/v1/updates`, `POST /updates/check`, `/updates/engines/{name}/apply`, `/updates/engines/{name}/rollback` |
| Tools | `POST /stack/v1/check`, `GET /check/latest`, `POST /service/restart`, `POST /host/reboot` |
| Helper | See [the Helper](helper.md) |

Writes the page makes ask the admin first and show the API's own sentence when one fails.

## Admin actions

`POST /stack/v1/service/restart` answers 202, then asks the service manager (launchd or systemd) to restart the Stack about a second later. It answers 409 when the Stack was started by hand. `POST /stack/v1/host/reboot` answers 403 `reboot_disabled` unless `stack.admin.allow_reboot` is on. `GET /stack/v1/logs` redacts tokens, keys, cookies, passwords, session ids and setup codes before the lines leave. Each action is logged as `admin.action.<name>` with its source (`admin`, `home` or `helper`).

## Roles as settings

`stack.roles.<role>.enabled` and `stack.roles.<role>.priority` are declared settings (ADMIN-04). A role that is off is not launched or admitted, and `GET /stack/v1/roles` gives the reason. Priority orders the governor's queue; the default is 100 for every role, so nothing changes until one is ranked. `profiles/apply` writes these settings, audited, and starts any missing pinned installs.

## Building and serving

`cd admin-ui && bun run build` writes `admin-ui/dist`. A source run serves `admin-ui/dist`. A compiled build serves an `admin-ui/` folder beside the binary, copied by `scripts/build-binary.sh`. `STACK_ADMIN_UI_DIR` overrides both. If the files are missing the route answers 503 `admin_ui_missing` with the command that builds them. The page sets a strict content security policy (`default-src 'self'`). It makes no request outside the Stack's own origin.

## Screenshots

`bash scripts/make-admin-screenshots.sh` starts a scratch Stack on a free port with its own temporary data folder, makes the admin account through the real setup route, and drives headless Chrome over the DevTools protocol. It writes every screen at 1280 and 375 pixels wide, light and dark, to `docs/images/admin/`. The scratch Stack has nothing installed, so in the browser only, the answers that would show this computer's own state are replaced with made-up demo data from `scripts/admin-screenshots/fixtures.ts`. Settings, the tier recommendation, the model catalog and sign-in are the Stack's own. Set `CHROME_BIN` for a Chrome in another place, `SHOTS_ONLY=overview,health` for some screens, and `SHOTS_OUT` for another folder. Open each image before using it.

## Known gaps

The backlog rows ADMIN-01 to ADMIN-11 in [BACKLOG.md](../BACKLOG.md) list what the routes lack: GPU and tokens per second are null, there is no read of retained engine builds (the page remembers the `previous` tag of an update in the browser), no download progress, and no admission decisions in sentences.
