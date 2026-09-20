# MaiPai Stack

MaiPai Stack is the engine foundation of MaiPai Home: the headless
service that installs, sizes, runs, watches, updates and tests the
engines and models behind Home, and gives Home one stable address by
role. It has no interface and no users of its own; Home is its only
caller. It ships inside [MaiPai Home](https://github.com/getmaipai/home)'s
installer and updates with Home's releases; there is nothing here to
install or run on its own.

This repo is the daemon: one Bun process serving the OpenAI-shaped role
routes and the control routes on a loopback port, with the supervisor,
the memory governor, the pinned engine and model store, health, updates
and the event feed behind them. The design record is
[docs/dev.md](docs/dev.md), the contract Home and Bot build against is
[docs/integrations.md](docs/integrations.md), and what is built and
what is missing is [docs/BACKLOG.md](docs/BACKLOG.md). Standards live
in [getmaipai/.github](https://github.com/getmaipai/.github);
`scripts/check.sh` is the gate and needs sibling checkouts of
`getmaipai/.github` and `getmaipai/shared`.

---

MaiPai is open-source software for personal, self-hosted, non-commercial
use by you and your household. It is not affiliated with, endorsed by, or
sponsored by any platform it can connect to. All product names and
trademarks belong to their respective owners. You are responsible for
complying with the terms and laws that apply to you and the services you
access.

The models the Stack downloads are made by third parties and chosen by
you. What they produce can be wrong, offensive, or harmful, and is not
medical, legal, or professional advice. You are responsible for how you
use it.

Licensed under [AGPL-3.0](LICENSE).
