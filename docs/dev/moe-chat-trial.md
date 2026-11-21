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

## Not verified without a live install

The pins, optional plan rows, selection by setting, launch arguments, prepare step (against a fake Splash and once against the real files in a scratch folder) and removal are tested. A real first start of the launcher with `--model-dir`, the first-token numbers on this build, and the fallback when macOS is older than Splash needs have not been run on a live Stack.
