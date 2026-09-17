# Changelog

All notable changes to MaiPai Stack are recorded here. The format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/). Everything stays 0.x until
the product passes its battle-tested checklist in `docs/dev.md`.

## [Unreleased]

### Added

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

### Security

- Bumped `drizzle-orm` to `^0.45.2` to address the SQL injection advisory.

### Fixed

- Model re-registration no longer clears installed model state.
- Existing model files are verified by checksum before they are marked installed.
- Fixed the remaining block B review findings across supervisor timeouts,
  liveness, streaming refusal, provenance errors and advisory model sizes.
