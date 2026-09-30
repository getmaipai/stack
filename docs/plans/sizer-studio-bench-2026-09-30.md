# The sizer's Studio bench: what to measure before more models get numbers (2026-09-30)

## Why this exists

The fit planner (`POST /stack/v1/fit-plan`) and admission agree with each other by construction, but every number under them was measured on one 24 GB laptop with two small dense models (Qwen3 1.7B and 4B) and one MLX model (Qwen3 1.7B 4-bit). That is why only `qwen3` gets numbers today and everything else reads "unknown". This runbook says what the Studio must measure so more architectures can join the verified lists, and what "verified" means, so nobody has to decide it again per model. It is a plan for a bench lane to run on the Studio, not something to run beside the family's hub on the laptop.

## What gets measured

Each row is one model at four contexts (4096, 16384, 32768, 65536), one request per context that fills about 0.85 of it, exactly the method of SIZER-BAKE-04 and 05 (idle footprint, the peak of a one-second sampler while the request runs, and the footprint right after and five seconds after).

| Row | Engine | Model | What it settles |
|---|---|---|---|
| A1 | mlx-serve | Qwen3 8B, 4-bit | the constants at a second size of the verified family |
| A2 | mlx-serve | Qwen3 32B, 4-bit | the same at the size a Studio actually runs |
| B1 | mlx-serve | Qwen3 30B-A3B (mixture of experts), 4-bit | whether weights-plus-KV holds when only some experts are active |
| C1 | mlx-serve | Gemma 3 12B, 4-bit (sliding-window attention) | whether the full-context KV formula only overestimates, as it should |
| D1 | llama-server | Qwen3 30B-A3B Q4_K_M | `gguf-parser` and `llama-fit-params` on a mixture of experts against the real allocation |
| D2 | llama-server | Gemma 3 12B Q4_K_M | the same on sliding-window attention |
| D3 | llama-server | Llama 3.1 8B Q4_K_M | a third dense family |
| E1 | mlx-serve with `--kv-quant 8` | Qwen3 8B, 4-bit | the smaller KV factor for a quantized cache that STACK-SIZE-11 left unmeasured |

For every row also record the plan (`POST /stack/v1/fit-plan` for the same model and context, with the Stack's own defaults) and admission's estimate for the same numbers, so each measurement is a three-way comparison: real, plan (low and high), admission.

## What "verified" means

An architecture joins `VERIFIED_ARCHITECTURES` (GGUF, in `backend/src/lib/fitPlan.ts`) or `VERIFIED_MLX_MODEL_TYPES` (MLX, in `backend/src/lib/mlxMemory.ts`) only when, at every tested context of its rows:

1. the measured peak is not above the plan's high figure (the plan may never say a model fits when it does not; this is the safety rule and has no tolerance);
2. the measured peak is not below 0.85 times the plan's low figure (a plan whose range misses the measurement from above is wrong in the other direction);
3. the plan's high figure is at most 2.0 times the measured peak. A looser plan is still safe, so it does not block verification, but the row is marked "loose" in the record and the factor that makes it loose gets its own item.

A row that fails rule 1 or 2 changes a constant or a formula first (a new item, never a silent edit), and the whole matrix for that family is rerun.

## Rules for the bench lane

The bench runs on the Studio with its own data directory and its own ports, never the household's running hub. Each server is one process the lane started itself, killed by the PID its own command printed, one at a time, with a free-memory guard of 25 percent (the memory guard of SIZER-BAKE-05). These rows measure memory and pass or fail, not time, so a bench may run beside a gate (the org rule for what holds a gate). Records name the engine build, the model file and a sanitized hardware line (never a hostname); results go in the "Fit planning versus admission" section of `docs/dev.md` as one table, and the code change that adds an architecture to a verified list is its own reviewed commit that cites the table.

## What comes out

A table of the three-way comparison for every row, the verified lists updated for the architectures that pass, a `loose` note for those that pass loosely, an updated `MLX_KV_PEAK_FACTOR_LOW` and `MLX_KV_PEAK_FACTOR` (or a statement that they held), and a factor for a quantized MLX cache from row E1. Rows that need a model the Studio cannot load or the Catalog does not pin yet are listed as skipped with the reason.
