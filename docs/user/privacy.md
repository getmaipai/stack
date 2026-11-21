# What stays on your computer

Your chats, voice, pictures and settings stay on your computer. The Stack never sends them anywhere. It only reaches out for software, and only when you ask.

## What stays

- Everything you ask the engines, and every answer.
- Your admin password. It is stored as a salted hash, never as the password.
- The Helper's questions and answers.
- The diagnostics zip. It has secrets removed, and the Stack never sends it. You choose whether to share it.

## What leaves, and when

| What | When | Who receives it |
|---|---|---|
| A check for engine and model updates | Only after you click **Check now**, or if you turn on **Check for updates** in Settings | The Catalog's signed index on GitHub, and the engine's public release page |
| A model or engine download | Only when you install one or apply an update | Hugging Face, or the host named in Settings, and GitHub |
| Building an engine's Python environment | When you install a feature that needs one | The Python Package Index |
| The Stack's own download | Only when you run the installer's `install` or `update` | The release address, GitHub by default |

Each request carries a file name and a version, never anything about you. The check says only that it is the Stack, its version and your system type.

The full list for your version is in the [integration notes](../integrations.md#the-privacy-rows).

## Who can open the admin page

Only this computer, unless you turn on **Admin page over Tailscale** in Settings. That adds your own Tailscale address, never your home network. The page always needs the password.

## Still need help?

Read [If something is not working](fix-a-problem.md).
