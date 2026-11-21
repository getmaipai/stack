# The Helper

The Helper is the admin page's chat assistant (HELPER-01, ADMIN-09). It answers questions about the Stack and, with an approval click, changes things. It has its own role, process and model, so it works when `chat` is down. The bench that chose its model is [docs/helper-bench.md](../helper-bench.md). The code is `backend/src/lib/helper.ts`, `helperTools.ts`, `backend/src/routes/helper.ts` and `admin-ui/src/Helper.tsx`.

## The role

`helper` is a `jit` role on `llama-server`, declared in [components.md](../components.md) like every role. It is not on `/v1`, and Home cannot reach it. Its model is Qwen3-4B Q4_K_M, the judge's pinned file, so there is one copy on disk and no pin of its own. It loads on the first message (about 4 seconds) and unloads after `stack.engines.helper.keep_warm_minutes` idle minutes (default 5, never below 1) through the governor's `jit` idle limit. It takes its slot through the admission governor like any engine, and is first to unload under critical pressure. Resident size is about 3.9 GB.

## Routes

Admin session only. Home's token gets 403 `admin_only`.

| Route | What it does |
|---|---|
| `GET /stack/v1/helper/status` | Installed or not, state, keep-warm minutes, the pinned model row, the tool list. |
| `GET` and `DELETE /stack/v1/helper/history` | The chat and the pending approvals, or clear both. History is one `meta` row, 40 messages at most. |
| `POST /stack/v1/helper/chat` | Body `{ message }`, up to 2000 characters. Answers `{ reply, pending, tools, wake_ms }`. 409 when the model is not installed, 503 when it could not start. |
| `POST /stack/v1/helper/approvals/{id}/approve` | Runs one parked change. 404 when it is no longer waiting (an approval lasts 10 minutes), 502 when the Stack refused it. |
| `POST /stack/v1/helper/approvals/{id}/deny` | Drops it. |

Installing the model uses the ordinary `POST /stack/v1/models` with the row from `helper/status`.

## What it can do

Read tools run at once: health, roles, memory, hardware, updates, settings and logs (redacted). Every write is parked as a pending approval and runs only on Approve, through the same in-process routes the page uses: switch a role on or off, change a setting, restart an engine or the Stack, check, apply or roll back an update. Each approved change is logged as `admin.action.helper.approved`, source `helper`, approved by admin.

It cannot reboot the computer, edit files, run commands, change `stack.admin.*` or secret settings (refused even after a click), or reach the network. The wording of an ask is fixed by the Stack, not by the model.

## Safety

Log lines, engine output and setting text reach the model as data, never as instructions, and the system prompt says so. The barrier is the click: a model that is fooled can only park a request that a person then reads. The Helper speaks only to the signed-in admin, never to a household member, so Home's child and adult gates are untouched. Nothing is sent anywhere.

## Not built

`@role` pointing, a context meter, a streamed reply, the standalone installer's optional Helper step, and a bench of answer quality beyond tool choice. The "Install the Helper" button is on the Helper screen.
