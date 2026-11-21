<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/getmaipai/.github/main/brand/maipai-stack-logo-dark.png">
    <img src="https://raw.githubusercontent.com/getmaipai/.github/main/brand/maipai-stack-logo-light.png" alt="MaiPai Stack" width="360">
  </picture>
</p>

### Run local AI engines on your own computer, from one web page.

[User docs](docs/user/index.md) · [Install](docs/user/install.md) · [Developer docs](docs/dev.md) · Releases (none published yet)

MaiPai Stack runs the engines behind private, local AI: chat, voice in, voice out, a wake word, and pictures, video and music when you want them. It installs the parts, checks them against pinned checksums, keeps them all inside your computer's memory, and tells you in plain words when one needs help. Everything runs on your computer. Nothing is sent anywhere unless you switch on an update check or download a model.

You manage it from one admin page. MaiPai Home, the family AI hub, uses the same Stack, and you can also run the Stack alone, with no Home.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/admin/overview-desktop-dark.webp">
  <img src="docs/images/admin/overview-desktop-light.webp" alt="The admin page Overview: status, version, memory, and one card per feature showing which model answers." width="720">
</picture>

## What it does

- **One address per job.** Ask for chat, speech, or a picture at one local address. The Stack picks the engine.
- **Features you switch on or off.** Chat, voice in, voice out, wake word, vision, images, video, music, and more.
- **Models you choose.** Pick from a pinned list, see the size, download or remove with one button.
- **Memory that fits.** A setup for your computer (16, 32, 64 or 128 GB) and a priority order for when memory is tight.
- **Honest health.** A short list of problems, each with one fix button.
- **Updates you can undo.** Update an engine, go back if the new one misbehaves. The Stack itself rolls back too.
- **A Helper.** A small built-in assistant that answers questions about the machine. It asks before it changes anything.

## Getting started

About 10 minutes on a Mac with Apple Silicon. You need [Bun](https://bun.sh) installed.

No release has been published yet, so you build one first. From a checkout of this repo (the build needs sibling checkouts of `getmaipai/commons` and `getmaipai/.github`, see [docs/dev/installer.md](docs/dev/installer.md)):

```
bash scripts/release-stack.sh v0.1.0
```

That writes the release files to `release/`. The install steps, and how to install from a published release once there is one, are in [docs/user/install.md](docs/user/install.md). After install, open `http://127.0.0.1:8770/admin/` and enter the one-time setup code that the installer points you to.

> The Stack listens on your own computer only. The admin page needs a password. Reaching it from another device is off unless you turn on the Tailscale option in Settings.

## Status

MaiPai Stack is pre-1.0. Home runs on it every day, so the engines work. The standalone install and the admin page are new: macOS on Apple Silicon is tested, Linux is not, Windows is not supported. Tell us what you find.

## Documentation

- [User docs](docs/user/index.md): install, sign in, choose features and models, update, fix a problem, privacy.
- [Developer docs](docs/dev.md): the design record, plus the [admin API](docs/dev/admin-api.md), the [Helper](docs/dev/helper.md) and the [installer](docs/dev/installer.md).
- [Integration contract](docs/integrations.md) for Home and Bot, and [what is pinned today](docs/components.md).
- Found a bug? Open an issue on this repo.

## Development

This repo is one Bun daemon (`backend/`) and the admin page (`admin-ui/`). `scripts/check.sh` is the gate and needs sibling checkouts of `getmaipai/.github` and `getmaipai/commons`. `bash scripts/make-admin-screenshots.sh` regenerates the screenshots in `docs/images/admin/`. Standards live in [getmaipai/.github](https://github.com/getmaipai/.github).

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
