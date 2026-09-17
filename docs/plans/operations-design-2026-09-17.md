# The Stack's operations: storage, sizing, health, updates

Researched and decided 2026-09-17 on Jesse's ask: read how the best
local-AI and local-service tools do these four things, decide what
works, looks current, and stays easy to use and maintain, then build.
Each section records the findings that mattered (primary sources), the
decision, and the item that builds it. The design record (`../dev.md`)
gets the decisions in its own sections as each item lands.

## 1. Storage, download, import, uninstall

### What the field does

- **Ollama** stores every layer as a raw file named by its content,
  `blobs/sha256-<hex>`, with an OCI-style manifest per model tag that
  lists its layers. A GGUF layer is the unmodified file, so any
  llama.cpp opens it by path. `ollama rm` recomputes references from
  every manifest and unlinks only blobs nothing else uses; a prune
  sweep gives a one-hour grace so a pull in progress is not clobbered.
  `pull` downloads 16 ranged parts in parallel with a progress sidecar
  per part, resumes each part from its offset, and only after a full
  SHA-256 of the assembled file does it write the manifest
  (`manifest/paths.go`, `manifest/manifest.go`, `server/download.go`,
  `server/images.go`). Hugging Face implements the Ollama registry
  protocol server-side, so `hf.co/<user>/<repo>` pulls need no
  Modelfile.
- **The Hugging Face cache** (`huggingface_hub`, "Manage your cache"):
  `models--<org>--<name>/{blobs,refs,snapshots}`, snapshots are
  symlinks into `blobs/<hash>`, `refs/main` holds the commit,
  `.incomplete` files resume by byte range, and `hf cache rm` deletes
  only blobs no remaining revision references. **mlx-lm reads this
  cache directly** (`mlx_lm/utils.py` `_download()` uses
  `snapshot_download`), so a model there needs no copy.
- **oMLX** downloads into its own `~/.omlx/models/<repo>` and deletes
  with `rmtree`; **mlx-serve** into `~/.mlx-serve/models/<org>/<repo>`
  with serial `curl -C -` resume, a size check and no checksum, and no
  `rm` at all; **LM Studio** into `~/.lmstudio/models/<publisher>/<model>/`
  as plain files. None of the three handles a file shared by two
  tools.
- **llama.cpp releases** are `bNNNN` tags with
  `llama-bNNNN-bin-<os>-<arch>[-<backend>].tar.gz|zip` assets and no
  checksum file, but GitHub's release API exposes a per-asset
  `digest` (`sha256:...`), the one published checksum. Ollama ships
  one binary and per-backend libraries under `lib/ollama/<backend>`,
  updated only with the whole app.

### Decision

1. **Models live in the Hugging Face cache layout**, under the Stack's
   data directory (`data/models/hub/models--<org>--<repo>/{blobs,refs,snapshots}`),
   and `HF_HUB_CACHE` points there for any Python engine the Stack
   spawns. mlx-lm, oMLX (when pointed at it) and every HF-aware tool
   then share the bytes; nothing is copied twice.
2. **Engines are content-addressed and versioned**:
   `data/engines/<name>/<tag>/` with a `manifest.json` (asset URL,
   size, the GitHub digest, our own recorded sha256), verified before
   extract, extracted to a temp dir and renamed atomically, with a
   `current` link per engine that rollback re-points. This replaces
   the flat `engines/<id>` directory from STACK-03.
3. **Import, never re-download**: on first run and on demand the Stack
   scans `~/.cache/huggingface/hub`, `~/.ollama/models`,
   `~/.mlx-serve/models`, `~/.omlx/models` and `~/.lmstudio/models`,
   offers what it finds, and links (hard link on the same volume,
   symlink otherwise) into its own store with provenance
   `source: <tool>`, the path, and a digest; Ollama blobs carry their
   sha256 in the filename, the rest are hashed once. It never writes
   into another tool's directory.
4. **Downloads** use ranged parallel parts with per-part progress and
   resume, a `.partial` rename, and a full-file sha256 before the
   record is marked verified, for models and engines alike (the
   Ollama shape; our current single-stream resumable download is the
   fallback for servers without range support).
5. **Uninstall** is reference-counted: a model's manifest lists its
   blobs, only blobs no other manifest references are deleted, a blob
   that is a link into another tool's directory loses only our link,
   and a prune sweep has a one-hour grace.
6. **The CLI vocabulary** people already know: `pull`, `list`, `run`,
   `rm`, `import`, on the daemon's API, later as a small `stack` CLI.

Reading another tool's user-data folder needs no licence; none of
their code is vendored; every model keeps its own licence in the record.

**Builds it:** STACK-04b (the store layout, import, reference-counted
remove, ranged downloads), a design section in `dev.md` first.

## 2. Health, watchdog, Repairs, alerts

### What the field does

- **Tailscale** keeps one daemon-owned health list (`health.Tracker`):
  each unhealthy item carries a code, a severity (high triggers a
  modal where the GUI can; medium is shown prominently; low appears
  only in settings), a title, text, since-when, and what it depends
  on. The GUI gets it as `ipn.Notify.Health` and surfaces changes; the
  CLI prints `# Health check:` lines from the same list. One list,
  every surface renders it (`health/health.go`, `ipn/backend.go`).
- **Home Assistant Repairs**: an issue is created with an id, a
  severity (critical, error, warning), a translated explanation, a
  learn-more link, and optionally a fix flow; re-raising the same id
  updates it, deleting clears it; the Settings sidebar shows a badge
  count; the page is one card per issue with a single Fix or Learn
  more button. Persistent notifications use the same idempotent
  `notification_id`. Its update entity carries installed and latest
  versions, release notes, backup-before-update and progress.
- **Ollama**'s updater polls the vendor hourly with a device id and a
  signed header: the one pattern here not to copy.
- **Service managers**: launchd `KeepAlive {SuccessfulExit: false}`
  restarts only on failure and `ThrottleInterval` (default 10 s)
  stops a spin; systemd `Restart=on-failure`, `WatchdogSec` with
  `WATCHDOG=1` pings, and `StartLimitBurst` cap a crash loop; the
  readiness and watchdog protocol is a plain datagram to
  `$NOTIFY_SOCKET`, implementable without libsystemd (sd_notify(3),
  "Standalone Implementations"); Windows uses `SERVICE_FAILURE_ACTIONS`
  with a reset period.
- **Alert channels without a vendor**: Telegram's bot API is a direct
  HTTPS call from the box and `getMe` validates a token; ntfy is
  self-hostable, and its iOS instant push needs an upstream relay that
  carries only a message id and a topic hash, never content. Uptime
  Kuma's channel model is a provider registry keyed by type with a
  "test this channel" call that returns the provider's own error.
- **macOS notifications**: a bare daemon or LaunchAgent cannot use
  `UNUserNotificationCenter` (no bundle); `osascript` attributes the
  notification to Script Editor; Tauri's plugin posts under the app's
  bundle id only when bundled. The tray app is the only honest sender.

### Decision

1. **One health list, daemon-owned.** `Health items` with `code`,
   `severity` (`critical | error | warning`), `title`, `text`, `since`,
   `cause`, at most one `fix` (`label`, `action`) and a `learnMore`
   link, keyed and idempotent (raising the same code updates, resolving
   deletes). `GET /stack/v1/health` returns the list; the event feed
   carries `health.changed`; the board, the tray and the future CLI
   render the same list. This subsumes the Repairs table from
   STACK-09: a Repair is a health item with a fix.
2. **Severity drives presentation only**: critical is a tray badge
   plus a native notification; error is a tray badge; warning shows on
   the Health page. The board's Repairs card is the HA page: a badge
   count, one card per item, plain title, why, one Fix or Learn more,
   Ignore as the only other control.
3. **Three watchdog layers, none of them a second daemon.** The
   service manager restarts on failure only, throttled (launchd
   `KeepAlive {SuccessfulExit: false}`, `ThrottleInterval 30`; systemd
   `Restart=on-failure`, `WatchdogSec=30`, `StartLimitBurst=5`; Windows
   restart twice then stop, reset after an hour). The daemon exits 0
   on a deliberate stop and non-zero on failure, pings `WATCHDOG=1`
   itself over `NOTIFY_SOCKET`, restarts engine children with backoff,
   and raises a health item instead of restarting a child forever.
   The tray polls `/healthz` and `/stack/v1/health` as an independent
   observer: when the daemon is down it says so and offers Start.
4. **Alert channels** are `{type, name, config, verifiedAt}` in a
   registry keyed by type, shipping Telegram (direct) and ntfy
   (self-hosted URL first; ntfy.sh optional and labelled as leaving
   the house). Every channel form has "Send a test" that delivers a
   real message naming the machine and shows the provider's error
   inline; an unverified channel is itself a warning item. Each
   channel is a row on the privacy page.
5. **Native notifications are posted only by the bundled tray app**;
   the daemon never shells out to `osascript` or `terminal-notifier`.

**Builds it:** STACK-09b (the health list replacing Repairs, severity,
`health.changed`), STACK-15 (the service files with the throttle
settings above and the `NOTIFY_SOCKET` ping), STACK-09c (alert
channels with the test flow and privacy rows), and the tray item.

## 3. Updates: the app, engines, models

### What the field does

- **Sparkle** (the Mac standard) checks an appcast daily by default
  (minimum hourly), asks the person once before enabling checks, signs
  archives with EdDSA, supports delta and phased rollouts, and sends a
  system profile only when the app opts in (default off). **Tauri 2's
  updater** reads a static JSON manifest (`version`, `notes`,
  `pub_date`, per-target `url` and inline minisign `signature`) or a
  dynamic endpoint that answers 204 for "no update", with a check,
  download (progress events), install flow; a bundled sidecar updates
  only with the whole app.
- **Home Assistant's update entity**: installed and latest version,
  a short summary and a notes link, backup-before-update, progress,
  skip this version, and `update.became_available` as a trigger; the
  OS keeps two boot slots so rollback is "boot the other one".
  **Ollama** auto-downloads on Mac and Windows with "Restart to
  update" in the menu bar and documents no rollback; **LM Studio**
  auto-updates its engine runtimes by default (off in settings) and
  shows release notes after.
- **llama.cpp today**: semver tags (`v0.4.1`) are the releases, and
  each one's only asset is `nightly-tag.txt` naming the `bNNNN` build
  whose prerelease carries the binaries. There is no checksum file;
  GitHub computes an immutable sha256 per asset at upload
  (`assets[].digest`). Unauthenticated API calls are 60 per hour;
  `If-None-Match` gets a 304. **`llama-server` cuts in-flight
  generations on SIGTERM** (`server.cpp` `signal_handler` sets
  `running=false`; pending waiters terminate), so draining is the
  supervisor's job, never the engine's.
- **Hugging Face**: `GET /api/models/{repo}` returns the head commit
  `sha` and honours ETag; `HEAD .../resolve/main/<file>` returns
  `x-repo-commit`, `x-linked-etag` (the file's sha256) and the size;
  anonymous limit 500 API calls per five minutes. Neither Ollama nor
  LM Studio watches model revisions.
- **The page**: HA 2022.4 set the shape everyone copies: one list, a
  badge count, installed and available side by side, notes inline,
  Skip per version, a backup toggle, one Install, live progress.

### Decision

1. **Three manifests we host, one per class** (`app.json`,
   `engines.json`, `models.json`), Tauri-shaped: `version`, `notes`,
   `pub_date`, per-target `url`, `sha256`, `size`, and a minisign
   signature; published from the release skill as GitHub release
   assets, never a MaiPai server in the path.
2. **Checking is opt-in**, offered once on the second launch (the
   Sparkle rule), default daily, minimum hourly. A check sends
   `If-None-Match` and a user agent of `maipai-stack/<version>
   (<os>-<arch>)`, nothing else: no query string, no profile, no id.
   The privacy page lists the three URLs and those two headers.
3. **Engines pin by `bNNNN`**; the semver tag resolves to it through
   `nightly-tag.txt`; the recorded sha256 is ours, cross-checked
   against GitHub's `digest`; the GitHub API is polled only at the
   manifest interval with ETag, well inside 60 per hour.
4. **Drain and swap is ours**: mark the role `draining`, stop routing
   new requests to it, wait for in-flight completions up to 60 s, then
   SIGTERM, then SIGKILL after 10 s; start the new build, pass
   `/health` and the post-load completion, then flip routing. A failed
   health check after the swap rolls back automatically and raises a
   health item.
5. **Keep the previous build**: `engines/<name>/<tag>/` directories,
   the last known-good always retained, rollback is a relink plus a
   restart with no download (the two-boot-slot idea, per engine).
6. **Model revisions are watched, never auto-applied**: store the
   repo `sha` and each file's `x-linked-etag` at install; a weekly
   conditional GET on `/api/models/{repo}`; a changed `sha` with a
   changed file etag means "a newer version exists"; the old file
   stays until the new one loads and passes its check.
7. **The Updates page** is one list: name, installed and available,
   size, a one-paragraph summary with a notes link, `Update`, `Skip
   this version`, `Go back to previous`, live progress, and the two
   plain states "Last checked <time>" and "Checks are off".

**Builds it:** STACK-10 (the manifests, the opt-in check, drain and
swap, keep-previous and rollback, the model-revision watch, the page's
API), with the release skill producing the manifests.

## 4. Sizing and memory governance

### What the field does

- **llama.cpp** now fits by dry run, not formula: `--fit` (default on)
  loads the model with `no_alloc`, creates a context, reads
  `llama_get_memory_breakdown()` per device, shrinks the context toward
  `--fit-ctx` (floor 4096) and overflows MoE experts to CPU, keeping
  `--fit-target` (1024 MiB per device) free; `llama-fit-params` prints
  the resulting flags (`common/fit.cpp`, `tools/server/README.md`).
  The KV cache is `2 * layers * kv_heads * head_dim * ctx * slots *
  bytes_per_element` (f16 2, q8_0 34/32, q4_0 18/32). `/health` is
  503 while loading and 200 when ready; `/slots` and `/metrics` report
  live slot use.
- **Ollama** deleted its estimator (`llm/memory.go`, 2025-11) and lets
  llama-server fit with `-ngl auto`; its pre-flight guess is admitted
  to be crude and conservative; real accounting comes after load by
  parsing llama-server's verbose buffer log lines. Its scheduler evicts
  when a guess exceeds 80 percent of free, evicts everything and
  retries on an out-of-memory, and holds three models per GPU with a
  five-minute keep-alive. On macOS it computes free memory from
  `host_statistics64` and caps the GPU at
  `recommendedMaxWorkingSetSize`.
- **LM Studio** estimates roughly twice the measured footprint in
  reported cases and blocks loads on unified-memory Macs that would
  have fit, because it reads `MemAvailable` and a formula; its
  guardrail is a settings object with an "always allow" escape.
- **oMLX** measures the process's `phys_footprint` via
  `proc_pid_rusage` (the number jetsam compares), ceilings at
  `min(total minus a reserve of 8, 6, 4 or 2 GB by mode, a reclaimable
  estimate, the Metal cap)`, runs two watermarks (soft at 85 to 92
  percent: evict LRU unpinned and pause admission; hard at 95: abort
  in flight), polls every second when active, and never raises
  `iogpu.wired_limit_mb` itself; it suggests a value leaving five
  percent of RAM. Its pre-load estimate is the safetensors size times
  1.05, replaced by the observed process delta after the load settles.
- **macOS signals a daemon can read**: `kern.memorystatus_level`
  (available percent, the same number `memory_pressure` prints) and
  `kern.memorystatus_vm_pressure_level` (1 normal, 2 warn, 4 critical,
  a dispatch mask); `host_statistics64` for free, inactive and
  purgeable pages; `proc_pid_rusage` for each engine's footprint. All
  reachable from Bun through `bun:ffi` against libSystem (verified
  with a probe on this Mac). **`os.freemem()` is wrong on macOS**: it
  is libuv's free page count and read 0.09 GB on a 24 GB Mac that was
  61 percent free.

### Decision

1. **Measure, do not estimate.** Before a first load, the number on
   the badge comes from llama.cpp's dry run (`llama-fit-params` for
   GGUF; for MLX, load and read the footprint delta) and is stored
   per model and context; the formula (weights plus KV plus a compute
   floor) is only for a model not yet downloaded, labelled
   `(estimated)` as the UX doc already says. After every load the
   supervisor records the measured footprint and llama-server's
   buffer lines, and that number replaces the estimate everywhere.
2. **The governor reads the kernel's ledger, never `os.freemem()`**:
   every 5 s (1 s while a load is in flight) `kern.memorystatus_level`,
   `kern.memorystatus_vm_pressure_level`, `host_statistics64`, and
   each engine's `phys_footprint`, through a small `bun:ffi` module
   with a Linux (`/proc/meminfo` `MemAvailable`, PSI) and a Windows
   (`GlobalMemoryStatusEx`) twin behind one interface.
3. **Two watermarks, oMLX's shape**: soft (evict the least recently
   used unpinned JIT model, pause admission) and hard (abort the
   in-flight generator job, raise a critical health item), on top of
   the rules already declared in STACK-06; a pressure level of warn
   or critical from the kernel counts as the soft or hard watermark
   regardless of our own arithmetic.
4. **Profile tiers from `hw.memsize` minus a reserve** (8 GB safe, 6
   balanced, 4 aggressive; 4 flat under 24 GB), capped by
   `max_recommended_working_set_size`; the tier is the largest
   resident set that fits at the household's real context length,
   confirmed by the first-run dry runs, not by file sizes.
5. **Never raise `iogpu.wired_limit_mb` silently.** Propose it once on
   the Hardware page with the five-percent-of-RAM ceiling and the
   exact command; the person decides.
6. **The mistake every tool makes** and this one will not: trusting a
   formula or `MemAvailable` where the kernel and a dry run can be
   asked.

**Builds it:** STACK-06b (the kernel-ledger reader with three OS
twins, the watermarks, the dry-run measurement path, the per-model
measured footprint), before the Studio's first-day bench (STACK-14).
