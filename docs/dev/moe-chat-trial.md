# Qwen3.6-35B-A3B chat on Splash

The Huihui Qwen3.6-35B-A3B abliterated Q4_K_M is an optional chat model run by Splash with a DFlash2 draft. Like the dense Huihui Qwen3.8-27B, an admin installs it on purpose and chooses it in Settings; no tier recommends, binds or downloads it, and the default chat model and engine are unchanged. This page covers what installs, how an admin selects it, and how to set it back. (The file name keeps the trial's name.)

## What it is

| Part | Id | Source | Size |
|---|---|---|---|
| Chat model | `qwen3-6-35b-a3b-huihui-abliterated-q4-k-m` | `mradermacher/Huihui-Qwen3.6-35B-A3B-abliterated-GGUF` @ `0693fc2b47f6` | 21.17 GB |
| Draft | `qwen3-6-35b-a3b-huihui-abliterated-dflash2-draft` | `incoai/Qwen3.6-35B-A3B-DFlash2` @ `51ef7b6923ad` | 1.05 GB |

Both are Apache-2.0 and pinned by revision and sha256 in `backend/src/lib/modelCatalog.ts`. Measured on Splash 1.6.1: 21 GB resident at 32k context, 399 ms to first token on a 5.5k-token Home prompt (the dense 27B took 2163 ms), 149 tokens per second (the dense 27B 55).

## Install

On p64 and p128 the disk plan offers an optional row, "chat-splash-qwen36-abliterated", with the 35B and its draft (22.2 GB together); the install-plan route lists both under `optional_models`. Install both. The install then runs Splash's own preparation step once: `install.local.prepare_local_model(<gguf>, draft=<draft folder>, models_dir=<Splash HOME models folder>)`, which hashes the GGUF once (about 8 seconds measured) and derives the config and tokenizer. Splash refuses a model folder built by hand, so the Stack never lays one out itself.

- The step runs after both files verify, from the component install and from the per-model install.
- A note at `<data>/splash/prepared-qwen36-35b.json` holds the pins prepared. A changed pin runs the step again; unchanged pins skip it.
- If the Splash engine is not installed yet, the step waits; the launch prepares the model the same way at the first start.
- Removing the model or its draft deletes the prepared folder and the note.

## Select it, and set it back

In Settings, AI and models, "Choose a model for Chat, Standard" lists the 35B on p64 and p128 once the room holds its 23 GB (the row says so when it does not). It is the last Standard candidate, so the recommended model for Standard, Boost and Max on every profile is unchanged and nothing picks it by itself. To set it back, choose the recommended model (or the dense 27B) in the same dialog, or clear `stack.engines.chat.model`.

What the Stack does when the model is loaded (`POST /stack/v1/models/<id>/load`, which is how Home's chat model choice reaches it): the load prefers the 35B before the setting exists, `auto` picks Splash for it, the Stack stores `stack.engines.chat.model`, and one chat model stays resident with the memory guard on. The Stack never sees Home's saved tier slot, so the slot alone does not change the running model; a load or the setting below does.

| To get | Set |
|---|---|
| The 35B on Splash | `stack.engines.chat.model` = `qwen3-6-35b-a3b-huihui-abliterated-q4-k-m`, with `stack.engines.chat.engine` on `auto` (a stored 35B makes `auto` pick Splash) or `splash` |
| Back to the tier's chat model | clear `stack.engines.chat.model` |
| The dense 27B | `stack.engines.chat.model` = `qwen3-8-27b-huihui-abliterated-iq4-xs` (llama-server), plus `stack.engines.chat.engine` = `splash` to run it on Splash |

Restart the chat engine after changing either setting. If Splash is unsupported, not installed or fails twice, chat says why and uses llama-server with the tier's chat model. One chat model is resident at a time and the memory guard stays on: the launch budget is the estimate (weights and draft times 1.08, plus 8 KB per context token, about 24.3 GB at 32k) or the measured footprint if larger, plus the headroom setting. The tier candidate peak is 23 GB, and no tier resolves to it.

The launch passes `--model <repo> --model-dir <gguf> --draft-model <draft folder>` and the same flags as the dense chat launch (`--offline`, `--served-model-name`, `--thinking-token-budget`, `--max-context`, `--max-memory`, `--idle-release off`, `--max-cache-disk 0`).

## Flash Next 177B (the Max chat model)

`qwen3-8-flash-next-177b-huihui-abliterated-iq4-xs` (Huihui Qwen3.8 Flash Next abliterated v2, UD-IQ4_XS, Qwen community licence) with its draft `qwen3-8-flash-next-177b-dflash2-draft` (Apache-2.0). It uses the same path as the 35B, from one list (`SPLASH_LOCAL_CHAT_MODELS` in `modelCatalog.ts`): optional disk row `chat-splash-qwen38-flash-next` on p128 only (about 94.9 GB), selection by `stack.engines.chat.model`, prepare step, launch with `--model-dir` and `--draft-model`.

- **Split GGUF.** The weights are three parts (93.68 GB together). They are one directory model: the existing `download.files` list pins each part by size and sha256, the first part is the pin's file, and the parts land in one folder. Splash is given the first part and reads the others beside it. No new download code.
- **Memory.** Measured on a 128 GB M5 Max with Splash 1.7.0: 70 GB loaded at a 32K window, 74 GB after long code replies, 81 tokens per second, first token 1.13 s on a 6,400-token prompt. Splash keeps about 27 GB of the weights on the SSD, so the estimate counts only the rest (`ssdBytes` in the list). The pin fixes the window at 32,768 (`launch.contextLength`); the launch budget is the estimate plus the headroom setting.
- **Tier.** A Max chat candidate on p128 (peak 75 GB, measured), listed after Ornith so it is never the recommendation, and excluded from the automatic ladder. It runs alone: Max drains the other loads first. Home chooses it by sending its id.
- **Adopting files already on the disk.** Before the install job runs, put (hardlink or move) each part at `<data dir>/models/<model id>/Qwen3.8-Flash-Next-UD-IQ4_XS/unsloth-UD-IQ4_XS/<part name>` and the draft's `config.json` and `model.safetensors` at `<data dir>/models/<draft id>/Qwen3.8-Flash-Next-DFlash2/`. The install hashes each file, fetches only what is missing or wrong, and nothing is downloaded when all match.

## Not verified without a live install

The pins, optional plan rows, selection by setting, launch arguments, prepare step (against a fake Splash and once against the real files in a scratch folder) and removal are tested. A real first start of the launcher with `--model-dir`, the first-token numbers on this build, and the fallback when macOS is older than Splash needs have not been run on a live Stack.
