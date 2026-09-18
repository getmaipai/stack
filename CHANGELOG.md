# Changelog

All notable changes to MaiPai Stack are recorded here. The format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/). Everything stays 0.x until
the product passes its battle-tested checklist in `docs/dev.md`.

## [Unreleased]

### Added

- STACK-19 engine management: operator controls, declarative engine
  configuration with restart state, derived version status, install progress,
  protected build removal, and the Engines page with Configure sheet.

- STACK-10 update manifests, opt-in conditional checks, engine tag swap and
  rollback controls, and the weekly model revision watch.

- The STACK-09b daemon-owned health list with idempotent health changes,
  resolve and ignore actions, Repairs compatibility, producer codes, and
  board cards with one Fix or Learn more action.

- The STACK-04b content-addressed store: Hugging Face cache layout, engine
  manifests, import scanning, ranged downloads with resume, storage
  accounting, migration, and reference-counted model and engine removal.

- The kernel memory ledger for STACK-06b: macOS FFI, Linux proc and PSI
  twin, Windows named stub, pressure watermarks, measured footprints, GGUF
  estimates, and llama-fit-params dry runs.
- The one-line macOS arm64 installer and compiled single-file daemon for
  STACK-15 and STACK-15b, with checksum verification and launchd service
  controls.
- Try it for STACK-12: a stateless chat surface with copied shadcn message
  primitives, live identity and latency metrics, voice offline states, and
  generator acknowledgement/job placeholders.
- The professional dashboard shell for STACK-11c: eleven Stack sections,
  responsive sidebar, search/command palette, monitoring chart, alerts,
  access view, and honest empty states for updates, backups, and Try it.
- The board-first install flow for STACK-11b: branded hardware and ability
  cards, deferred operator password, scripted setup downloads, pause/resume,
  and honest progress copy.
- Streaming chat completions now pass through OpenAI-shaped SSE chunks
  with identity headers, abort propagation, and usage counters.
- The first-run admin UI, operator login, role board, memory card,
  notifications and Repairs list, served by the Stack daemon.
- The event feed (`/stack/v1/events`, SSE with replay), the durable notification center, Repairs with one action each, and rotating redacted logs per engine.
- The hardware probe, profile tiers, and `/stack/v1/hardware` route.
- The pinned engine catalog, verified archive downloader, installer, and engine listing route.
- The model provenance store with Catalog and Hugging Face install paths and verified role selection.
- The spawned, managed, and URL supervisor with generation-safe restarts and real chat binding.
- The role declaration, hardware profile reconciliation, OpenAI-shaped route stubs, and identity contract.
- The Bun backend scaffold with a health route, OpenAPI explorer and SQLite metadata store.
- The docs site skeleton (`docs/site/`, Astro Starlight) and the first
  user pages (`docs/user/getting-started.md`,
  `docs/user/fix-a-problem.md`).
- The design record (`docs/dev.md`), the experience design (`docs/ux.md`),
  the integration contracts for Home, Bot, Go and Catalog
  (`docs/integrations.md`), the privacy page (`docs/user/privacy.md`) and
  the backlog.
- The generated API document (`docs/api/openapi.json`) and its drift check
  in the gate, with the API reference wired into the docs site.
- The "What your computer can run" page
  (`docs/user/what-your-computer-can-run.md`).
- Operator setup and login, role-scoped client keys, counters and revoke
  routes for the Stack API.
- The memory governor's admission, queue, eviction, cap and budget status
  route.
- The "Keys for your tools" user page
  (`docs/user/keys-for-your-tools.md`).

### Security

- Bumped `drizzle-orm` to `^0.45.2` to address the SQL injection advisory.

### Fixed

- Model re-registration no longer clears installed model state.
- Existing model files are verified by checksum before they are marked installed.
- Fixed the remaining block B review findings across supervisor timeouts,
  liveness, streaming refusal, provenance errors and advisory model sizes.
