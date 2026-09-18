---
title: "Privacy: what leaves your house"
description: What the Stack can send to the internet, and how to make sure nothing does.
---

# Privacy: what leaves your house

MaiPai Stack runs AI on your own computer. It does not send your chats,
images, voice, or anything you make to us or to anyone else. There is
no account with us, no analytics, and no crash reports.

Only explicitly enabled features can go out to the internet.

| What | When it happens | What it carries | Who receives it |
|---|---|---|---|
| Checking for updates | Only if you switch it on in Settings, then about once a day | A `GET` with exactly `If-None-Match` and `User-Agent: maipai-stack/<version> (<os>-<arch>)`, no query string or identifier | The `app.json`, `engines.json`, and `models.json` release assets on GitHub |
| Searching Hugging Face from Add | Only when you switch on the outbound update setting and search from the Add sheet | A `GET` with the search text and the same `If-None-Match` and `User-Agent` headers | `huggingface.co`, for the model search only |
| Downloading a model or an engine | Only when you pick one to install, or accept an update | The name of the file you asked for | The site that publishes it (for example Hugging Face or GitHub), straight from your computer |
| Installing the Stack | Only when you run the one-line installer | The installer script | `https://getmaipai.github.io/stack/install.sh` |
| Downloading the installer release | Only when you run the one-line installer | The Stack binary and its checksum file | `https://github.com/getmaipai/stack/releases/latest/download/maipai-stack-darwin-arm64` and `https://github.com/getmaipai/stack/releases/latest/download/SHA256SUMS` |
| Telegram alert channel | Only after you configure and verify a Telegram channel | The alert sentence and the configured chat ID | Telegram's Bot API |
| ntfy alert channel | Only after you configure and verify an ntfy channel | The alert sentence and the configured topic | The ntfy server URL you chose |
| Fetching Library docs | Only when the update switch is on and you choose Fetch the docs | The model or engine docs URL, with `If-None-Match` and the Stack user agent | The model host or engine documentation host |

Everything else stays on your computer. The Stack listens only to
programs on the same machine unless you choose to open it to your home
network, and even then every program needs a key you created.

Detection looks only at this computer's loopback addresses and local model folders.

If you install MaiPai Home on top of the Stack, Home has its own privacy
page for the things it can connect to (your accounts, the weather, and so
on). The Stack itself never talks to those services.

## Still need help?

Open the Stack, choose Settings, and check "Check for updates" is
switched off if you want nothing to leave at all. The Stack keeps working
without it.
