---
title: Keys for your tools
description: How to make a key for one program and how to turn it off.
---

See [Connect a coding tool](./connect-a-coding-tool/).

The first time you open the Stack, you set one login for yourself: a password, no email, no account with anyone. That is the only sign-in the Stack has.

A key is a different thing. A key is a password for one program, not for a person. You make a key for a tool you want to use the Stack with, like a script or a little app you wrote yourself.

To make a key:

1. Give the key a name, like "My backup script."
2. Choose which abilities it may use: chat, coding, voice, images, and so on.
3. Copy the key when it is shown. It is shown once, and you cannot read it back after.

For a coding tool, choose **A coding tool**. Stack selects Chat, Coding,
and Embeddings and then shows its address, the key, and a copyable setup
block. OpenCode, Aider, and Continue work with the OpenAI-compatible
connection today. Claude Code and Codex CLI need a different wire and are
coming later. Use `coding` as the model name.

A key is limited to the roles it may use. That protects you: a tool that only needs chat cannot start a video job, and a tool that only needs images cannot read your messages. You choose what it can spend, and nothing else.

To turn a key off, revoke it. The next time the tool asks for anything with that key, the Stack refuses it, and the tool sees the error it can act on. The key stays in your list, marked off, and you can make a new one whenever you want.

No key ever leaves your computer. Keys live on this machine, and the programs that hold them are the ones you made them for.

Still need help? Open fix-a-problem and look for "If a tool says it is not allowed."
