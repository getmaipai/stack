# The Helper

The Helper is the admin page's chat assistant (HELPER-01, ADMIN-09). It answers questions about the Stack and, with an approval click, changes things. It has its own role, process and model, so it works when `chat` is down. The bench that chose its model is [docs/helper-bench.md](../helper-bench.md). The code is `backend/src/lib/helper.ts` (the chat loop), `helperInterpret.ts` (reads a message first), `helperKnowledge.ts` (glossary, GB formatting, role words), `helperReads.ts` (read tools), `helperActions.ts` (proposals), `helperTools.ts` (tool list and prompt), `backend/src/routes/helper.ts`, and in the page `Helper.tsx`, `HelperPanel.tsx` and `helperChat.tsx`.

## The role

`helper` is a `jit` role on `llama-server`, declared in [components.md](../components.md) like every role. It is not on `/v1`, and Home cannot reach it. Its model is Qwen3-4B Q4_K_M, the judge's pinned file, so there is one copy on disk and no pin of its own. It loads on the first message (about 4 seconds) and unloads after `stack.engines.helper.keep_warm_minutes` idle minutes (default 5, never below 1) through the governor's `jit` idle limit. It takes its slot through the admission governor like any engine, and is first to unload under critical pressure. Resident size is about 3.9 GB.

## Routes

Admin session only. Home's token gets 403 `admin_only`.

| Route | What it does |
|---|---|
| `GET /stack/v1/helper/status` | Installed or not, state, keep-warm minutes, the pinned model row, the tool list. |
| `GET` and `DELETE /stack/v1/helper/history` | The chat and the proposals still waiting, or clear both. History is one `meta` row, 40 messages at most. |
| `POST /stack/v1/helper/chat` | Body `{ message }`, up to 2000 characters. Answers `{ reply, pending, tools, calls, dropped, wake_ms }`. `pending` holds proposal cards. 409 when the model is not installed, 503 when it could not start. |
| `POST /stack/v1/helper/actions/{id}/confirm` | Body `{ action, params }`, the same values the card showed. Runs the stored proposal once. 404 `not_found` (never proposed in this chat, or the chat was cleared), 409 `used` (already confirmed or cancelled), 409 `edited` (the posted values differ: nothing runs and the proposal is burned), 410 `expired` (10 minutes), 502 `change_failed`. |
| `POST /stack/v1/helper/actions/{id}/cancel` | Drops the card. |

Installing the model uses the ordinary `POST /stack/v1/models` with the row from `helper/status`.

## How a message is answered

1. **Read it first** (`helperInterpret.ts`, pure code, no model). It knows which words are tiers (Reduced, Standard, Boost, Max), engines (Splash, llama-server) and features (Chat, Coding, Voice in and out, Images, Video, Music), and which feature the question before was about, so "what about max" after a coding question means the Max tier for Coding. A clear command ("turn video off", "move music above voice out", "set coding priority to 5", "restart the voice out engine", "apply the recommended profile") becomes one typed action. Words that fit two features ("speech", "voice") become one short question and no card. Reboot, removing a model and passwords get a fixed answer that names the right screen.
2. **Run the reads that answer a question** before the model speaks, so the model only puts real facts into plain words. Every read returns sentences with GB, never bytes. `get_models` gives, per feature, which models are installed, which is chosen, which others the Stack offers, and the tier ladder; `get_engine_use` says what an engine is and what it holds; `explain` gives the glossary entry. The short glossary is also in the system prompt.
3. **The model** writes the answer, or, for anything the rules did not recognise, picks its own read tool or calls `propose_action`. A tool call typed as text is read back as a call.
4. **Check the answer.** A sentence with a number or model name that no tool returned this turn is dropped (`dropped` counts them). Each read may carry a one-sentence lead and the words the answer must contain; if the model left them out, the Stack's lead is the answer.

## Actions

The model never changes anything. `propose_action` takes one `action` from a fixed list (`set_role_enabled`, `set_role_priority`, `apply_profile`, `restart_engine`, `restart_stack`, `set_setting`, `check_updates`, `apply_update`, `rollback_update`) with a strict parameter schema. The Stack validates it against the real state (known feature, real setting, a value in range, an engine that exists), refuses a change that is already so, and stores a proposal: id, action, exact parameters, one plain sentence, each change as label, from and to, an optional note, and an expiry 10 minutes out. The page shows that as a card with Confirm and Cancel.

On Confirm the page sends `{ action, params }` back. The Stack checks the id was proposed in this chat, is still waiting, has not expired, and that the action and parameters are exactly the stored ones, then runs the stored copy through the same in-process routes the page uses (`PUT /stack/v1/settings` and `POST /stack/v1/settings/apply`, `POST /stack/v1/profiles/apply`, `POST /stack/v1/engines/{name}/restart`, `POST /stack/v1/service/restart`, the update routes). So the page does not call those routes itself; the confirm route does, which is what lets the Stack refuse an edited or unknown proposal. Audit lines in the Stack log: `admin.action.helper.proposed`, `.approved` (carries `approvedBy: admin`), `.denied`, `.rejected` (an edited confirm) and `.expired`, all with `source: helper`.

Rebooting, removing a model and anything not on the list are not offered; a request for one gets the Tools or Models screen.

A failed read tool is never shown to the admin: the model gets a plain "could not read" note, and the reply is cleaned of tool names, raw errors, byte counts and any typed "Looked at" line. The page adds its own "Looked at" footer from the tools that succeeded.

## The page

The Helper is a slide-over on every screen: the sparkle button in the top bar, right of search, or `Cmd+/` (`Ctrl+/`). The chat state lives in `HelperProvider` above the screens, so closing and reopening the panel keeps it, and the Helper screen shows the same chat. It uses only `@maipai/ui` primitives and tokens, and works at 375 px.

## Eval

`backend/src/bench/helperEval.ts` runs 43 owner-style questions and actions (plus 16 held-out paraphrases, `--set held`) against a scratch Stack seeded by `helperEvalSeed.ts`, with the real Helper model. Expected facts are computed from that Stack. Method and numbers: [helper-bench.md](../helper-bench.md). `STACK_HELPER_INTERPRET=off` runs the model and its tools without the reading step, for comparison. Never run it against a live hub.

## Safety

Log lines, engine output and setting text reach the model as data, never as instructions, and the system prompt says so. The barrier is the click: a model that is fooled can only park a proposal that a person then reads, and the Stack runs only that stored proposal. The Helper speaks only to the signed-in admin, never to a household member, so Home's child and adult gates are untouched. Nothing is sent anywhere.

## Not built

`@role` pointing, a context meter, a streamed reply, and the standalone installer's optional Helper step. The "Install the Helper" button is on the Helper screen.
