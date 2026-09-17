# MaiPai Stack

The local AI foundation: one service on a person's own machine that
installs, sizes, runs, watches, updates and tests the engines and models
behind every MaiPai product, and gives any local client one stable
address to use them by role. MaiPai Home and MaiPai Bot are built on it;
a person who only wants local AI done right can run it alone.

Org standards apply and are auto-loaded from the parent directory
CLAUDE.md (source:
[getmaipai/.github](https://github.com/getmaipai/.github)).

Started 2026-09-17 as a design, no code yet: [docs/dev.md](docs/dev.md)
is the design record, [docs/ux.md](docs/ux.md) the experience,
[docs/integrations.md](docs/integrations.md) the seams with Home, Bot,
Go and Catalog, and [docs/BACKLOG.md](docs/BACKLOG.md) what is built and
what is missing. The hub's engine layer (`home/backend/src/lib/engine*`,
the supervisors, the governor, the downloads) is the hard-won logic to
copy from when the migration item runs; nothing migrates before the
Stack runs the Studio beside the hub (STACK-16).

## The line (the one repo-specific rule)

The Stack knows clients, not people. One operator login, per-client API
keys scoped to roles, no Person, no household, no memory, no history, no
personality, no packages. Test surfaces are stateless. The moment a
second person wants a turn, that is MaiPai Home's job, and the Stack's
page says so. Anything that needs to know who is asking does not belong
in this repo.

The ten design principles are in `docs/dev.md`; the first three are the
ones a session is most likely to trip on: roles not models, hosts are
engines never the platform, clients not people.

## Layout (planned, per STACK.md)

`backend/` (Bun, Hono with `@hono/zod-openapi`, Zod, Drizzle/SQLite),
`frontend/` (React, Vite, `@maipai/ui`), `docs/` (the three tiers),
`scripts/check.sh` (the gate: the repo's own lint, format and tests, then
the pinned `@maipai/standards` core, which needs a sibling
`getmaipai/.github` checkout at `../.github` or `MAIPAI_STANDARDS_DIR`).
A docs-only commit runs `bash scripts/check.sh --docs`.

Runtime data lives under `data/` and is never tracked. Every model or
engine the Stack uses is downloaded on demand, pinned and checksummed,
never vendored (org rule: download, don't vendor).

## Safety posture

Operator-only. The one-time adult acknowledgment before the first
generation, the AI-outputs disclaimer at first run, no jailbreak presets,
no reference-person imagery feature. Child safety lives in Home, where
children exist; nothing here may weaken it, and nothing here can, because
the Stack does not know who is asking. Role-scoped client keys are the
Stack's contribution: a client that must never reach a generator cannot.

## Privacy

Loopback by default. Two opt-in outbound classes, the update check and
downloads, both on [docs/user/privacy.md](docs/user/privacy.md). Adding
or changing an outbound endpoint updates that page in the same commit.
