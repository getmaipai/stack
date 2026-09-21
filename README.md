<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/getmaipai/.github/main/brand/maipai-stack-logo-dark.png">
    <img src="https://raw.githubusercontent.com/getmaipai/.github/main/brand/maipai-stack-logo-light.png" alt="MaiPai Stack" width="360">
  </picture>
</p>

MaiPai Stack is the engine foundation of MaiPai Home: the headless
service that installs, sizes, runs, watches, updates and tests the
engines and models behind Home, and gives Home one stable address by
role. It has no interface and no users of its own; Home is its only
caller.

[MaiPai Home](https://github.com/getmaipai/home)'s installer installs the Stack; a person never installs the Stack by itself.
It updates with Home's releases.

Local AI is a pile of parts. One program runs the chat model, a
different one turns speech into text, another turns text into speech, a
small model listens for the wake word, and a fourth draws pictures. Each
starts its own way, keeps its own files, needs its own slice of memory
and breaks in its own way. Home should never have to know any of that.
The Stack is the one interface between those raw parts and everything
MaiPai builds on top: Home asks for "chat" or "say this" at one address
and gets an answer, and the Stack decides which engine runs it, makes
sure the right model file is there and untampered, keeps every engine
fitting in memory at the same time, notices when one breaks and says how
to fix it, and swaps a new build in, or back out, without Home changing
a line. Swap an engine, add a role, move from the Mac to the robot's
Linux box: Home does not change. Without the Stack, every product would
carry its own copy of all that, and a kid asking for a picture could
crash the family's chat.

This repo is the daemon: one Bun process serving the OpenAI-shaped role
routes and the control routes on a loopback port, with the supervisor,
the memory governor, the pinned engine and model store, health, updates
and the event feed behind them. The design record is
[docs/dev.md](docs/dev.md), the contract Home and Bot build against is
[docs/integrations.md](docs/integrations.md), and what is built and
what is missing is [docs/BACKLOG.md](docs/BACKLOG.md), and what the Stack
pins today, engine by engine and model by model, is
[docs/components.md](docs/components.md), generated from the code.
Standards live
in [getmaipai/.github](https://github.com/getmaipai/.github);
`scripts/check.sh` is the gate and needs sibling checkouts of
`getmaipai/.github` and `getmaipai/commons`.

**Build**: `bash scripts/build-binary.sh` compiles the daemon into one
binary at `dist/maipai-stack-<platform>-<arch>` (`bun build --compile`),
plus `migrations/` and `backend-src/` (a real, dereferenced copy of this
repo's own `backend/`) as sibling directories the binary needs at
runtime - this is what Home's installer runs to place the Stack, never
something a person runs by hand. Verified live on every run against a
real scratch data directory: `/healthz`, and a real `stt` transcription
end to end (a compiled binary can never load `sherpa-onnx-node`'s
native binding directly - a Bun bundler issue tracked at
[getmaipai/stack#8](https://github.com/getmaipai/stack/issues/8) - so
the worker runs through a real `bun`, named by `STACK_BUN_BIN`, against
the vendored `backend-src/` instead). `SKIP_VERIFY=1` skips all live
checks; `SKIP_STT_VERIFY=1` keeps `/healthz` but skips the slower real
download. See `docs/dev.md`'s HOME-STACK-01 entry for the full story.

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
