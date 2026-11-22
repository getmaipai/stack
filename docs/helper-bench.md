# Helper model bench (HELPER-01)

The Helper needs a small instruct model with dependable tool calling.
The candidates are the 3 to 4 billion parameter models already pinned in
the catalog (URL, revision, checksum and licence recorded there): Qwen3-4B
Q4_K_M (the judge pin) and Qwen3-VL-4B-Instruct Q4_K_M (text side only).

Run on 2026-11-21 on the Mac Studio (Apple silicon, 128 GB), llama-server
`b12589`, `--jinja --reasoning off`, 8192-token window, temperature 0:

    bun backend/src/bench/helperBench.ts <llama-server> <name=gguf>...

The set is 16 fixed admin questions with the Helper's real tool list and
system prompt: 8 that need a read tool, 4 that need a write tool, and 4
that must call no tool (reboot the computer, print the admin password, a
greeting, a prompt-injection style request). A case passes when the first
tool call is the expected one, or when no tool is called for the four.

| Model | Right | Wake (cold start) | Reply speed | Resident |
|---|---|---|---|---|
| Qwen3-4B Q4_K_M (2.5 GB file) | 15 of 16 | 3.6 to 4.1 s | 93 to 101 tokens/s | 3.9 GB |
| Qwen3-VL-4B-Instruct Q4_K_M | 15 of 16 | 1.5 s (file cached) | 105 tokens/s | 3.8 GB |

Both missed the same case: "Install the latest update." chose
`check_updates` (look first) instead of `apply_update`. That is the safe
direction, because installing needs an engine name and an Approve click
either way.

**Chosen: Qwen3-4B Q4_K_M** (`qwen3-4b-q4-k-m`, Apache-2.0, revision
`bc640142c66e1fdd12af0bd68f40445458f3869b`). Equal accuracy; it is
text-only, needs no projector file, and it is the file the judge role
already pins, so one 2.5 GB copy serves both. The Helper runs it in its
own process; the role shares the file, not the process.

Not measured: answer quality beyond tool choice (the live check in the
backlog row covers real answers), and the larger Qwen3-8B (5 GB), left out
because the plan targets 2.5 to 3 GB resident files.

## Answer-quality eval (2026-11-22)

The tool-choice bench above does not say whether the reply is right. This eval does:
`backend/src/bench/helperEval.ts` asks the real Helper (Qwen3-4B Q4_K_M, llama-server `b12589`, temperature 0) 43 owner-style questions and actions on a scratch Stack seeded by `helperEvalSeed.ts` (the Helper's model, both coding models installed, music off, Mac Studio 128 GB). It includes the three that went badly in the owner's chat, word questions (tier, engine, role), follow-ups, ambiguous asks, impossible asks and 11 actions. A case passes on the reply the admin reads: the expected facts are in it (sizes within 0.6 GB, or 1.5 GB for a moving figure), a card with the exact action and parameters came back or no card came back, an ambiguous ask got one question, and no raw byte count or tool name leaked. Expected facts are computed from the scratch Stack's own routes.

16 more paraphrases (`--set held`) were written after the Helper was tuned on the first 43 and were not used to shape it.

| Run | Main 43 | Held-out 16 |
|---|---|---|
| Before (old tools and prompt) | 17 (39.5%) | 4 (25%) |
| Better tools, prompt, glossary, GB formatting, memory, grounding, no reading step (`STACK_HELPER_INTERPRET=off`) | 32 (74%) | 12 (75%) |
| After (all of the above plus the reading step) | 43 (100%) | 16 (100%, one run had 15) |

Median time for an answer: about 0.2 to 0.6 s once awake (reads and actions are mostly answered without the model).

Read these numbers with care. The 43 were used while building, so 100% on them is partly fitted. The held-out 16 are the fairer figure, and 16 is a small set. The row without the reading step shows how far the 4B model gets alone: wrong tier and engine answers and invented actions are the misses.

No alternative model was benched: Qwen3-4B with the reading step passes the set, and the plan forbids an unpinned model. If a later change makes the 4B fail, the pinned alternatives are Qwen3-VL-4B-Instruct (above) and the 8B chat model.
