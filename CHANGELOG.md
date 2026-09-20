# Changelog

All notable changes to MaiPai Stack are recorded here. The format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/). The Stack has no
release of its own: it ships inside MaiPai Home's installer and updates
with Home's releases, so this file tracks what a Home release picks up.

## [Unreleased]

### Security

- The Python environments the Stack builds for Pocket TTS and ComfyUI
  moved to torch 2.13.0 and setuptools 84.0.0 (the Dependabot alerts
  on torch up to 2.12.1 and setuptools below 83.0.0), recompiled with
  hashes on 2026-09-20. torch 2.13 ships wheels for macOS 14 and later
  only, so those two engines now need macOS 14 or later on an Apple
  silicon Mac; the build refuses an older Mac with the reason.

### Added

- The voice engine runs offline always; the Stack fetches a voice a
  request names, or the voice-cloning weights when voice cloning is
  turned on with a token, once and verified, before the engine uses
  it, and refuses a voice it cannot pin or cloning it cannot serve
  with the reason (2026-09-20). New setting
  `stack.engines.tts.voice_cloning`.
- A second chat engine for Apple silicon Macs, mlx-serve v26.9.4, as a
  pinned release beside llama-server; `stack.engines.chat.engine`
  chooses which one serves the chat wire after a restart, and an MLX
  model installs as a directory of files, each checksummed
  (2026-09-20).

### Changed

- The Stack is MaiPai Home's engine foundation, not a product
  (2026-09-20, `.github/docs/DECISIONS.md`). The backend was started
  fresh on that design: the governor, the kernel memory readers, the
  model store and its on-disk layout, the resumable checksummed
  downloads, the engine catalog and install, the identity probe, the
  health list, the role declaration, the profiles, the engine swap and
  rollback, and the launchd service were kept with their tests; the
  supervisor is now per role (spawned, managed, or a read-only url
  binding) with the same lifecycle; the event feed is one typed
  server-sent stream that stays open and replays by sequence; every
  setting is declared once and served for Home's renderer; readiness,
  updates against the Catalog's signed index, the job queue shape, the
  privacy rows, the precious-state declaration and the diagnostics
  bundle are routes Home calls. Loopback is the only authentication.
- The shared helpers (log, withTimeout, paths, archive, the zip writer,
  the hardware probe, the openapi router) come from `@maipai/core` in
  `getmaipai/shared` (pinned `core-v0.1.0`); the local copies are gone.
- The state database has three tables (`meta`, `models`, `health`) and
  one migration. A data directory from before the refocus does not
  migrate (nothing was ever installed): the daemon refuses it with a
  message naming the path.

### Removed

- The console, the showroom, the library, the palette, the helper, the
  MCP server, the Tauri desktop app, the installer and docs site, the
  operator login, client keys, the alert channels, detection and
  adoption of other tools, model groups, the series and live samplers,
  the weekly digest, storage hygiene and accounting, the network probe,
  the licence sentences, the setup plan, the speed test, the
  maintenance scheduler (Home owns every schedule and calls the Stack's
  routes), the Stack-release update manifests, the user docs tier, the
  release workflows, and every test and script for them. The product
  era's history is in git at `d4e088e`.
