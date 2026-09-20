# jev and YuE: two candidates for the Stack (2026-09-20)

Web research only. No installs, no runs, no repo edits outside this file.

Note on how this file's scope changed mid-research: the jev subject was
redirected twice during this session, first toward "jev is LangChain's new
agent harness" (contradicted by the LangChain post itself, which is about
plugging the Jev decision model into a harness, not Jev being one), then to
the framing used below (Jev as TypeSafe AI's System One decision model). The
framing below is the one this session verified first-hand against primary
sources, independent of either redirect. Flagging this so the owner can
confirm the redirects were intentional.

## The two-paragraph answer

Jev is not a music model, and as of this research it is not a locally
runnable model of any kind for MaiPai's purposes. It is TypeSafe AI's
"System One" model, released 2026-09-18 by a startup founded by former
OpenAI/ChatGPT contributor Diogo Almeida ($40M seed). It does not chat or
generate text; given context and a predefined output schema it returns a
typed, calibrated decision (a label, a score, a probability) and is pitched
as 40 to 200 times faster and far cheaper than an LLM for exactly the kind
of routing, classification, and gating decisions Home's turn engine already
makes deterministically or with a small local model. That would make it an
interesting fit for the turn engine's judge, act, emotion, and stance roles
in principle, except for the one fact that settles it: Jev is served only
from TypeSafe's own metered, waitlisted API (`api.typesafe.ai`), with no
published weights and no announced self-hosting or on-prem path as of
2026-09-19. Per the owner's own rule, "hosted only" is an automatic no for
anything in MaiPai's turn engine. Verdict: no, not for the Stack, not now.
Revisit only if TypeSafe publishes weights, or if one of the open
reproductions (below) publishes a calibration study against human labels,
which the org's rule for adopting a learned component requires before it
can even enter shadow mode.

For the music role, YuE2 is the more capable model on paper (symbolic
planning, zero-shot covers, agentic score editing, 48 kHz stereo, up to
five-minute songs, strong academic pedigree) but it is officially a Linux
and NVIDIA product: the maintained repo requires a 24 GB BF16 CUDA GPU,
documents no Apple Silicon path, and its current weights carry a CC BY-NC
4.0 license that requires contacting the developers for anything
commercial, a regression from YuE v1's Apache-2.0 weights. None of that
runs on the Mac Studio the Stack is built for without depending on
third-party, low-provenance MLX forks that cannot be pinned by URL,
revision, and sha256 with any confidence. ACE-Step 1.5 fits the Stack's
constraints as given: MIT license on both code and weights, an official
MLX/MPS backend built into the same repo (not a fork), an ungated
Hugging Face download, a built-in HTTP REST server (`acestep-api`), a
practical VRAM range (under 4 GB with CPU offload up to 12-20 GB+), and
full songs with vocals in the same 10 second to 10 minute range YuE2
targets. Recommendation: ACE-Step 1.5 for the music role, not YuE2, and
not jev for anything until it ships weights.

## Subject 1: jev

**What it is.** Jev is TypeSafe AI's first "System One model": a
transformer-based model that is explicitly "not a large language model." It
takes context plus a caller-defined schema of possible outputs and returns
a typed, calibrated decision with a probability, instead of free text. The
company's pitch is that because outputs are constrained to a predefined
schema, it "mathematically cannot hallucinate or produce type errors."
Verified: [TechCrunch, "A new kind of AI model from a ChatGPT inventor is
thrilling developers," 2026-09-18](https://techcrunch.com/2026/09/18/a-new-kind-of-ai-model-from-a-chatgpt-inventor-is-thrilling-developers/),
read 2026-09-20. Verified: [DataCamp, "Jev: TypeSafe's System One Model That
Never Hallucinates"](https://www.datacamp.com/blog/system-one-models-jev),
read 2026-09-20.

**How a decision is asked.** Input is context plus a defined set of
possible outputs (the caller enumerates the schema in advance: categories,
booleans, ratings). Output is one of those typed values plus a calibrated
probability. Verified: TechCrunch 2026-09-18 (above); the LangChain
integration post shows this in code as a Pydantic-modeled decision object.
Verified: [LangChain, "Building a Harness with Jev" /
"What Is Jev? A Guide to TypeSafe AI's System One
Model,"](https://www.langchain.com/blog/building-a-harness-with-jev) by
Sydney Runkle, read 2026-09-20 (fetched directly, dated 2026-09-17). This
post is what triggered the "jev is a harness" redirect; it is not accurate.
The post's own content shows Jev as a decision layer a developer wires into
a LangChain-built agent loop (`TypeSafeClassifier` used with a
`ModelRouter` and `AutoMode` middleware), not a harness itself. LangChain's
actual "batteries-included agent harness" products are `deepagents` /
`deepagentsjs`, separate projects.

**Local-only or hosted-only (the deciding question).** Hosted-only, no
open weights, no self-hosting or on-prem option announced. The endpoint is
`POST https://api.typesafe.ai/v1/systemone`, current model route
`jev-latest`, gated behind an early-access waitlist as of 2026-09-18/19,
with a metered pricing model (input tokens billed per billion, output
tokens free). Verified: multiple independent sources converge on this:
[geotoolbox.ai, "What Is Jev? TypeSafe AI's New Non-Chat Model,
Explained"](https://geotoolbox.ai/blog/what-is-jev-ai), and
[modemguides.com, "Jev AI Reality Check: Can You Run TypeSafe's Model
Locally?"](https://www.modemguides.com/blogs/ai-news/jev-typesafe-reality-check-run-locally),
both read 2026-09-20 via search snippet, both stating no published weights
and no on-prem option. This is consistent with TechCrunch's account of the
company "briefly losing the ability to serve users from its API because
demand was so high," which only makes sense for a hosted service.

**Parameters, size, training data, calibration.** Parameter count and
architecture are undisclosed by TypeSafe. Training data is synthetic,
generated by TypeSafe itself: founder Almeida is quoted saying "We made an
early bet that we will be making all of our data," and the method is
described as "reinforcement learning from calibrated decisions." No
calibration methodology (e.g., expected calibration error against a
held-out human-labeled set) is published in any source this session read.
Verified: TechCrunch 2026-09-18 (above). Fine-tuning: not addressed in any
source read. Inference: given the model is API-only with no weights,
household fine-tuning on local labels is not possible regardless.

**License.** Not published as an open license; the model is a proprietary,
commercial API product. No repo, no LICENSE file, no Hugging Face model
card for the official model exists. Inference, based on the complete
absence of a license artifact anywhere this session found it.

**Latency and cost.** TechCrunch reports results "5 to 18 times more
quickly" than a comparable OpenAI model in a Vercel-run example, and
description elsewhere of "40 to 200 times faster" than frontier LLMs on
comparable classification tasks, at "$0.042 per million input tokens with
free output" per the original search summary, though TechCrunch's own
figure is input billed "by the billion, not the million." These two
pricing descriptions are not fully reconciled between sources; treat the
exact number as unconfirmed. Verified (directionally): TechCrunch
2026-09-18 (above).

**Maturity.** Released 2026-09-18, days old as of this research
(2026-09-20). Not an open-source project, so "contributors" and "issues"
in the GitHub sense do not apply to the official model; a large community
reproduction effort sprang up within 48 hours, tracked at
[Hugging Face Space, "Jev Reproductions
Tracker"](https://huggingface.co/spaces/multimodalart/jev-reproductions-tracker)
and [GitHub, `AbdelStark/awesome-typesafe`, a curated list of TypeSafe/Jev
resources](https://github.com/AbdelStark/awesome-typesafe), both read
2026-09-20 via search snippet, not fetched directly.

**Open, locally-runnable reproductions (not Jev itself).** Several
community projects reproduce Jev's typed-decision behavior on open weights
a household could run locally. None of these is Jev, none is verified
against a published calibration study in the sources this session read,
and per the org's rule a learned component earns adoption only after its
measured false-positive rate beats the deterministic rule it would
replace, in shadow mode first.
- `openjev` (razorback16): a "Jev-compatible System One decision server"
  on DiffusionGemma 26B-A4B (Apache-2.0), served through vLLM, weights
  (~18 GB) auto-downloading to the Hugging Face cache. Verified (search
  snippet): [GitHub,
  `razorback16/openjev`](https://github.com/razorback16/openjev), read
  2026-09-20, not fetched directly.
- `jeff` (logan-markewich): "a self-hosted drop-in replacement for
  TypeSafe's jev, powered by GliFormer," 400M parameters. Verified (search
  snippet): [GitHub,
  `logan-markewich/jeff`](https://github.com/logan-markewich/jeff), read
  2026-09-20, not fetched directly.
- `com-kotobalabs/open-jev-deberta-v3-large`: an open, Jev-shaped typed
  decision model on Hugging Face, built on DeBERTa-v3-large. Verified
  (search snippet), read 2026-09-20, not fetched directly.
- Two early LoRA-based replicas reported two days after Jev's launch:
  "Kev" (Qwen2.5-0.5B + LoRA + readout head, by Jared Palmer) and "Bespoke
  Nimble" (Qwen3.5-9B + LoRA, by Bespoke Labs, 90.12% accuracy on a
  324-example held-out set versus Jev's reported 93.21%). Verified
  (search snippet): [Medium, "Just Two Days After Jev Went Viral, Two
  Open-Source Replicas Are
  Here"](https://ai-engineering-trend.medium.com/just-two-days-after-jev-went-viral-two-open-source-replicas-are-here-one-9b-one-0-5b-57024ceef03e),
  read 2026-09-20.

None of these were fetched and read in full; they are named here as the
starting point for a future evaluation, not as vetted candidates.

**Where Jev (or a local reproduction) would fit if it were usable.** Home's
turn engine already has the shape this would slot into: a deterministic
router, a judge role, an honesty check, act/emotion/stance classification
on utterance embeddings, and safety checks that the org's rules require to
stay deterministic (a learned check may run in shadow mode beside them,
never as the gate). The org's rule also says three phrasings piling onto
one regex family in a week is a classifier candidate, not a fourth regex,
which is exactly the shape of decision Jev targets. Inference, from the
org's own documented architecture (`getmaipai/CLAUDE.md`, "Rules, word
lists and learned components").

**Comparison: Jev versus Home's current decision path**

| | Jev (hosted) | Small local LLM as judge | Embedding + linear head | Regex/word list |
|---|---|---|---|---|
| Locality | Cloud API only, automatic no | Fully local | Fully local | Fully local |
| Latency | Reported 5-18x faster than a frontier LLM call, but still a network round trip | Slowest of the four; a full generation pass | Fast; one forward pass, no decoding | Fastest; no model at all |
| Calibration | Claimed "calibrated probabilities"; no published methodology found | Poor by default; LLMs are not calibrated classifiers without extra work | Can be calibrated (temperature scaling, held-out set) if trained on real labels | Not probabilistic; a hit or a miss |
| Training data needed | None (TypeSafe's own synthetic data); can't be fine-tuned by a household | Prompted, no training | Needs labeled examples; org rule requires frontier-model or human labels, not small-model labels (the ACT-02 lesson) | None; hand-written by an engineer |
| License / adoptable | Proprietary API, no license artifact found | Whatever the local model's license is | The org's own code | The org's own code |
| Maturity | 2 days old at first check, days old now | Mature, in production in Home already | Standard technique, proven elsewhere in Home | Mature, but the org's own rule caps it at three phrasings before retirement |

**Recommendation for jev.** No. Hosted-only is an automatic no under the
owner's own rule, independent of how good the calibration claims are. Do
not trial in shadow mode, because there is nothing to self-host. Revisit
only if TypeSafe ships weights, or if one of the open reproductions above
is fetched, read in full, and shown (with a real calibration study against
human-labeled data) to beat the current path on the metric it would
replace.

## Subject 2: YuE / YuE2

**What it generates.** Full songs: a vocal track aligned to supplied
lyrics plus instrumental accompaniment, in one pass. YuE (v1) generates up
to five minutes; YuE2 outputs 48 kHz stereo audio without quantization and
adds an intermediate, editable symbolic score (melody and chords) before
audio synthesis, plus zero-shot cover generation from a transcribed
reference and conversational ("agentic") score editing. Verified:
[`multimodal-art-projection/YuE` README, fetched
2026-09-20](https://github.com/multimodal-art-projection/YuE/blob/main/README.md);
[project site, map-yue.github.io, fetched
2026-09-20](https://map-yue.github.io/).

**Model sizes and files.** YuE v1: S1-Model, 7B parameters (COT and ICL
variants, separate checkpoints for English, Chinese, and Japanese/Korean),
S2-Model, 1B parameters, plus a separate upsampler, pretrained on
"trillions of tokens." YuE2: YuE2-3B (the main generation model), plus
YuE2-Vae (default audio decoder) and YuE2-Vae-legacy (benchmark decoder),
with SheetSage2 (transcription) and MERT-v2 (music understanding) as
supporting models. Exact on-disk sizes were not stated in the README or
setup doc this session read. Verified: README and
`skills/yue2-music/references/models-and-setup.md`, both fetched
2026-09-20.

**License, code versus weights.** Code, agent skill, and documentation:
Apache-2.0. Weights: CC BY-NC 4.0 plus additional creator permission. The
license text (as summarized in the README) grants free use and
monetization of YuE2 outputs for personal/creator use with no fees or
royalties, but requires a company to contact the developers directly for
commercial licensing of the weights. This is a step back from YuE v1,
whose weights were released under plain Apache-2.0 (per the project site's
own wording, "the YuE model, including its weights, is now released under
the Apache License, Version 2.0"), and that v1 code and license are
preserved on a separate `YuE-v1` branch, no longer the default. Verified:
README, fetched 2026-09-20; project site fetched 2026-09-20; Hugging Face
model cards for `m-a-p/YuE2-3B`, `m-a-p/YuE2-Vae`, and `m-a-p/YuE2-Vae-legacy`
confirmed via search snippet as `license: cc-by-nc-4.0`, read 2026-09-20,
not fetched directly.

**Runtime.** Officially: Linux, Python 3.12, PyTorch (auto-installed
alongside Transformers 4.57.6 and NumPy 2.2.6), an NVIDIA GPU with BF16
support and 24 GB VRAM minimum. SheetSage2 needs a separate Python
3.10-3.11 environment with PyTorch 2.8.0/torchaudio 2.8.0 and FFmpeg 6.1,
because its dependency versions conflict with the main model's. No Apple
Silicon (MPS or MLX) support is documented anywhere in the official repo;
CPU inference is technically possible in code but described as clearly
GPU-optimized, with no timing given. No generation-time figures for any
hardware are published in the docs this session read. Verified:
`skills/yue2-music/references/models-and-setup.md`, fetched 2026-09-20.

**Apple Silicon, unofficially.** A cluster of third-party projects wrap or
port YuE2-3B to Apple Silicon via MLX, all appearing after YuE2's release
and none affiliated with `multimodal-art-projection`: `vanch007/mlx-Yue`
(described as a native, Torch-free MLX port with Metal SDPA kernels and
8-bit AR quantization), `stavitian/yue2-studio` and at least one apparent
fork of it, `arinltte/YuE2Mac`, `xuyinuox-ui/YuE2-Studio`, `ianiv/YuE2`,
and a Pinokio packaging by `Rdx-ai-art`. These were found by search
snippet only, read 2026-09-20, none fetched directly, and their star
counts, maintenance state, and provenance were not checked. None can be
pinned by URL, revision, and sha256 with the confidence the Stack requires
for a Catalog package today; each would need individual vetting before
being trusted with a household's install.

**Maintenance state.** 9.9k GitHub stars, 17 open issues, 168 commits on
the main branch, latest tagged release `yue2-v0.1.6` in September 2026.
Verified: GitHub repo page, fetched 2026-09-20.

**Interfaces.** A staged Python API (`plan()` -> `generate_semantic()` ->
`synthesize()` -> `decode()`), command-line examples, and a hosted web demo
at `yue.noizai.net`. No self-hosted HTTP server (OpenAI-shaped or
otherwise) is documented in the official repo; a household running YuE2
locally would be building its own server around the Python API. Verified:
README and models-and-setup.md, fetched 2026-09-20.

**Safety and copyright.** Training data sources are not detailed in the
README. No watermarking scheme or voice-cloning safeguard is mentioned.
The license's "Responsible use" language prohibits illegal, harmful, or
deceptive applications and disclaims warranties; that is a licensing
clause, not a technical control. Verified: README, fetched 2026-09-20.

## The field for local music generation on a Mac, 2026

| Model | Generates | Params / size | Code license | Weight license | Apple Silicon | VRAM / RAM | Generation speed | Server | Maintenance (as read 2026-09-20) |
|---|---|---|---|---|---|---|---|---|---|
| **ACE-Step 1.5** | Full songs, vocals + instrumental, 10s-10min | LM 0.6B/1.7B/4B, DiT 2B/4B(XL); ~4.7-20GB on disk | MIT | MIT (weights on Hugging Face, ungated) | Official, in-repo: MLX + MPS launch scripts (`start_gradio_ui_macos.sh`, `start_api_server_macos.sh`); also a portable Metal/GGML C++ port (`acestep.cpp`) | Under 4GB with full CPU offload; 12-20GB+ recommended | Under 2s/song on A100, under 10s on RTX 3090; no official Apple Silicon number found | Built-in HTTP REST API (`acestep-api`), Gradio UI, CLI | 12.8k stars, 99 open issues, releases Jan 28 and Apr 2 2026, active GGUF/C++ community ports through Sept 2026 |
| **YuE2** | Full songs, vocals + instrumental, 48kHz stereo, symbolic planning, zero-shot covers | YuE2-3B + YuE2-Vae + SheetSage2 + MERT-v2; sizes not disclosed | Apache-2.0 | CC BY-NC 4.0 + creator permission (commercial needs direct contact) | None official; several low-provenance third-party MLX forks | 24GB NVIDIA BF16 GPU (official minimum) | Not documented | Python API + CLI + hosted demo; no local server documented | 9.9k stars, 17 open issues, release Sept 2026 (v0.1.6) |
| **Stable Audio Open (3.0 family)** | Music + SFX; Small/Medium/Large tiers, not centered on full-song-with-vocals the way ACE-Step/YuE are | 433M (Small/SFX) to 2.7B (Large) | Not separately confirmed | Stability AI Community License; free under $1M aggregate revenue, registration required | Small tier only, via CoreML; Medium/Large need CUDA | Small: consumer CPU/CoreML; Medium/Large: GPU, not detailed | Not documented in sources read | Not confirmed | Released 2026-05-20, active |
| **MusicGen / AudioCraft (Meta)** | Instrumental music with melodic conditioning; natively short clips | Small 300M, Medium 1.5B, Large 3.3B | MIT (code) | CC BY-NC 4.0 (weights) | Community-only MLX ports (`mlx-audiocraft`, `musicgen-mlx`); no official Apple Silicon | Varies by size, not detailed | Not officially benchmarked | None official; community Gradio/CLI only | Official repo largely research-archived; community forks carry 2026 activity |
| **DiffRhythm2** | Full songs, vocals + accompaniment, up to 210s | Not disclosed in sources read | Apache-2.0 | Apache-2.0 | Not documented; Linux-oriented instructions found | Not disclosed | ~60s to generate 4+ minutes of music per a cloud demo, not a confirmed local Apple Silicon number | Not confirmed local server; a cloud/ComfyUI wrapper exists | Active in 2026; DiffRhythm2 supersedes DiffRhythm v1 |

Everything in this table beyond ACE-Step 1.5 and YuE2 came from search
snippets and was not independently fetched and re-read; treat the Stable
Audio Open, MusicGen, and DiffRhythm2 rows as directional, not as fully
verified as the ACE-Step and YuE2 sections above.

## Open questions for the owner

- Does the Stack's "music role" need full songs with vocals (ACE-Step,
  YuE2, DiffRhythm2's territory), or does it also need short instrumental
  beds / sound effects (Stable Audio Open's differentiator)? That changes
  which model is even in contention.
- Is a household willing to accept a third-party, unofficial MLX port
  (for YuE2, since the maintained line has no first-party Apple Silicon
  support) if its feature set is wanted badly enough, or is "official
  support only" a hard bar for anything the Catalog pins? This session did
  not vet any of the YuE2 MLX forks for provenance or trustworthiness.
  This is a policy call, not a web-research question.
  Contact and license, and whether that's worth pursuing given AGPL-3.0.
- Real generation-time and quality numbers for ACE-Step 1.5 on the Mac
  Studio (M5 Max, 128GB) were not published anywhere this session found;
  the only numbers on record are A100 and RTX 3090. That needs a live
  measurement on the actual target hardware before this becomes a Catalog
  package, per the org's own verification standard.
- Whether it is worth a direct email to `m-a-p` (YuE2's developers) or to
  ACE-Step's maintainers to get a written commercial-use confirmation
  beyond what the public license text says, before pinning either into
  the Catalog. That is a legal/business question, not one a web page
  settles.
- Whether the owner wants this session (or a future one) to fetch and
  read in full the third-party YuE2 MLX ports and the Jev open
  reproductions named above, since none were opened past their GitHub
  search-result titles.
