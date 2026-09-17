<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/getmaipai/.github/main/brand/maipai-stack-logo-dark.png">
    <img src="https://raw.githubusercontent.com/getmaipai/.github/main/brand/maipai-stack-logo-light.png" alt="MaiPai Stack" width="360">
  </picture>
</p>

<h3 align="center">Your own local AI stack, made easy.</h3>

<p align="center"><a href="docs/dev.md">Documentation</a> · <a href="https://github.com/getmaipai/stack/releases">Releases</a></p>

The easy way to run your own local AI: the whole stack installed,
watched, tested and kept up to date on your own computer, for you and
anything you build on it. Nothing leaves your house.

## Features

- **One address**: an OpenAI-compatible API for chat, coding, embeddings,
  voice in, voice out, pictures, video and music, by role, never by model
  name.
- **Sized to your machine**: it measures what your computer can run and
  proposes a profile in plain words.
- **Provenance first**: every model shows where it came from, its
  licence and its checksum before it can be used.
- **One memory budget**: one governor decides what loads and what waits,
  so a video job never crashes your chat.
- **Watched**: a board of green lights, repairs with one action each,
  logs per engine.
- **Updates with rollback**: opt-in checks, one click to update, one
  click to go back.
- **Try it**: a stateless box per role to prove each one works.
- **Client keys**: each tool gets a key limited to the roles it may use.
- **Complete alone**: run it by itself, or install MaiPai Home on top for
  your family.

## Getting started

Not yet: the Stack is a design with no code. The first milestone is
tracked in [docs/BACKLOG.md](docs/BACKLOG.md).

## Status

Pre-alpha, design stage. MaiPai Home is what runs our own household
today; the Stack is the engine layer it will move onto.

## Documentation

- Design record: [docs/dev.md](docs/dev.md)
- The experience: [docs/ux.md](docs/ux.md)
- Integrations (Home, Bot, Go, Catalog): [docs/integrations.md](docs/integrations.md)
- Privacy: [docs/user/privacy.md](docs/user/privacy.md)
- Issues: [github.com/getmaipai/stack/issues](https://github.com/getmaipai/stack/issues)

## Development

Standards live in [getmaipai/.github](https://github.com/getmaipai/.github).
`scripts/check.sh` runs the pinned `@maipai/standards` core; it needs a
sibling checkout of `getmaipai/.github`.

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
