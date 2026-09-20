# The Studio bench protocol (STACK-74)

2026-09-20. The protocol STACK-14 runs on the Mac Studio, fixed before
the run so the numbers mean the same thing every time. One command,
`bash scripts/bench/studio-bench.sh`, does the whole run against a
clean scratch data directory through the public routes and writes one
report; nothing is hand-measured. The run itself waits for the Studio
(this laptop is a 24 GB `p16` and admits the pinned chat model only when
enough is free, STACK-96b); the laptop is the dry-run machine.

## What is fixed

**Machines.** The Studio (Apple silicon, 128 GB unified memory, tier
`p128`) is the machine the numbers are for. A run on any other machine
is a rehearsal of the protocol, reported with its own tier. The report
names the hardware as chip family and memory (`sysctl` brand string and
`hw.memsize`), never a hostname.

**Engine builds.** `llama-server` at the shipped pin (`b10797`, macOS
arm64, the build string from its own `/props`). `mlx-serve` and `oMLX`
are the candidates for the second adapter (STACK-93) and join the bench
the day their adapter exists; until then the protocol records their
absence rather than a number for them.

**Model files.** Named by id, repository, revision and sha256 as the
Stack's records carry them, never by a nickname. The first run uses the
shipped pin, `Qwen/Qwen3-1.7B-GGUF` Q8_0 at commit
`90862c4b9d2787eaed51d12237eafdfe7c5f6077`, sha256 `061b54da…590cb1a`,
so the protocol is proven on a file every machine can download. The
Studio's real candidates are Home's resident profiles
(`home/docs/plans/hub-on-apple-silicon-2026-09-17.md`, section 3:
Qwen3-Next-80B-A3B, GPT-OSS-120B, GLM-4.5-Air, each with a dedicated
judge, embed, STT and TTS); each is added as a pin with its provenance
before it is benched, and the bench takes the model ids on its command
line so the same script measures them.

**Context.** 4096 (the default, what the post-load check and the
readiness probe use) and 16384; each context is its own launch and its
own row. The Studio's two 64k slots are a third row once a 64k-capable
pin exists.

**Request mix.** Per model and context: (1) `llama-bench` from the
installed build, 512 prompt tokens, 128 generated tokens, three
repetitions (the shape the 2026-09-18 walk used: 2,218 prompt tokens/s,
115 generated tokens/s), run with nothing loaded in the daemon so its
own copy of the model never lands in the row's pressure window; (2) the
load through the public route, timed; (3) eight sequential streamed
`/v1/chat/completions` requests of a fixed 60-word prompt with
`max_tokens: 64`, timed to the first SSE chunk that carries content
(the first token, not the first byte of the stream) and to the end;
(4) with the chat model resident, one `/v1/embeddings` request when an
embed model is installed; (5) the readiness check
(`POST /stack/v1/check`) with its fit-together pass.

**Pressure samples.** `GET /stack/v1/hardware/budget` every 250 ms for
the whole run: free memory, the kernel's pressure level and the loaded
set. The report keeps the minimum free memory and the worst pressure
level seen, and the footprint the supervisor measured after the load
(`measuredFootprintBytes` on the model record).

**Pass thresholds.** A row passes when: the load completed and the
post-load check answered; kernel pressure never reached `critical`
during the run (`warn` is recorded, not a failure); the readiness check
reported the role ok and fit-together ok; the first-token time of the
eight route requests has a median under 1,000 ms once loaded; the
generated tokens/s from `llama-bench` is within 10 percent of the
latest previous report for the same model, context and build (the
script reads it from `data-bench/`; a larger drop fails the row, the
same rule the old speed test applied). A row with no previous run is
the baseline and says so.

**The rollback rehearsal.** Every bench run ends with
`scripts/prove-pin-rollback.sh` on the same scratch directory: stage
the build under a second tag, swap, roll back, the broken-build swap
relinking, the wrong checksum refused. Its transcript is appended to
the report; a bench whose rehearsal fails is not a passing bench.

## What the report holds

`data-bench/<timestamp>/report.md` and `report.json` (kept across runs
and git-ignored, apart from the daemon's own `data-scratch/`, which the
rehearsal removes): the hardware line, the tier, the previous report
compared against, the engine build string, per row the model id,
repository, revision, sha256, file size, context, load time, first
token, prompt and generated tokens/s with the previous run's, measured
footprint, minimum free memory and worst pressure, the readiness
result, pass or fail with the reason; then the rehearsal transcript. The summary rows are copied into
`docs/dev.md` "Measured so far" with the date, and the model's
`measured` block in `modelCatalog.ts` is filled from the footprint so
the components inventory prints it.

## Out of scope

Choosing a Studio model before the numbers exist; Home's migration
(STACK-16); the second engine adapter (STACK-93), which this protocol
measures the day it exists.
