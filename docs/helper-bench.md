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
