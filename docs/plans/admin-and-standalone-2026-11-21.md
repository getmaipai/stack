# Admin page and standalone Stack (plan, 2026-11-21)

Owner-approved: 2026-11-21 (Jesse). Rule text: AGENTS.md, "Standalone and admin exception".

## Goal

A person can install the Stack alone, open one web page, sign in, see what
runs, choose which features and models run, set their priority and tier,
restart things, and apply updates. Home uses the same routes. Nothing new
leaves the machine.

## Shape

One static single-page app bundled in `backend/`, served by the Stack. It is
a second caller of the existing `/stack/v1/*` API. No second copy of any
logic. Look: Uptime Kuma and UniFi calm, Apple clean, light and dark, phone
width, live through the SSE feed.

## Access and login

- First run prints a one-time setup code to the log and a 0600 file. The
  page then sets the one admin password. Salted hash in the Stack database.
- Session cookie (HttpOnly, SameSite strict, idle timeout), login rate limit.
- Reset: local command `stack admin reset` on the machine.
- Listens on loopback. Tailscale address only when the admin turns it on
  (declared setting, off by default). Never the LAN, never 0.0.0.0, unless
  the admin explicitly chooses LAN in standalone mode (open question 1).
- Home keeps its own key and skips the login page.

## Screens

1. **Overview:** overall status, version, uptime, memory pressure, one card
   per role with state and answering engine.
2. **Features:** switch each role on or off (chat, embed, speech to text,
   text to speech, wakeword, image, video, music).
3. **Models and priority:** per role, the pinned catalog choices, installed
   state, download, remove, and the order roles win memory when it is tight
   (priority). Tier picker (the existing profiles) with the fit decision
   explained in plain words.
4. **Engines:** installed versions, restart one engine, last log lines.
5. **Health:** problem list, one fix button each.
6. **Settings:** generic renderer over the declared settings, Apply.
7. **Updates:** installed, available, last checked, check, apply, go back.
8. **Hardware and memory:** live from `/memory` and `/hardware`.
9. **Tools:** diagnostics zip, readiness check, restart Stack, reboot
   computer (confirm, needs a sudoers line the installer adds).

## New backend pieces

- Admin auth routes (setup, login, logout, change password).
- `POST /stack/v1/service/restart`, `POST /stack/v1/engines/{name}/restart`,
  `POST /stack/v1/host/reboot`, `GET /stack/v1/logs?tail=` (redacted).
- Role enable/disable and role priority as declared settings (if not
  already), so Home and the page read one definition.
- Every new route: Zod types, OpenAPI regeneration, `integrations.md` rows,
  test. Admin actions logged with time and source; the privacy route lists
  the admin listener.

## Standalone pieces

- Standalone installer (macOS first, Linux next) that installs the Stack
  as a launchd or systemd service, prints the setup code, opens the page.
- README for GitHub (written last, with the `docs-writing` skill), user
  docs (grade 6), dev docs, generated screenshots from seeded data.
- Public release flow: tagged builds, checksums, update path that works
  without Home.

## Open questions (decide before step 6; defaults in bold)

1. Other apps (Open WebUI, scripts) calling the Stack's `/v1`: **optional
   API keys made on the admin page, loopback by default, LAN off unless
   chosen.**
2. Model choice beyond the pinned catalog: **catalog only in v1; "add by
   Hugging Face repo" later, still pinned and checksummed on install.**
3. Windows: **out of v1** (the pins exist for Windows CUDA, the service
   unit does not).

## Build order (each lands separately, gated)

1. Rule exception and this plan (this commit).
2. Admin account, sessions, listener binding, tests.
3. Restart, logs and reboot routes, tests.
4. Role enable and priority settings, tests.
5. Page shell with Overview, Health, Engines.
6. Features, Models and priority, Settings, Updates, Tools screens.
7. Screenshots from seeded data, opened and judged.
8. Standalone installer and update path.
9. README, user and dev docs, backlog rows, release.
10. Update org `DECISIONS.md` in `getmaipai/.github` with the 2026-11-21
    entry (separate repo, separate commit).

## Routing

Steps 2 to 4 and 8: Claude API worker or Codex (decided, testable). Step 1,
page design (5 to 7), the README and docs: this session.
