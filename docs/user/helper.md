# Ask the Helper a question

The Helper is a small assistant on the admin page. It answers questions about your computer's Stack, like "Is everything healthy?" or "How much memory is free?". When a change is needed, it shows a card and waits for your click. It takes about 3 minutes to set up.

The Helper has its own model, so it works even when chat is broken. It does not use the internet, and your questions stay on this computer.

## Install it

1. Open **Helper**.
2. Click **Install the Helper (about 2.5 GB)**. The download is checked against a checksum before it is used.
3. Wait. The chat opens by itself when the download is done.

## Ask something

Open the Helper from any screen: click the sparkle button at the top right, next to the search button, or press `Cmd` and `/` (`Ctrl` and `/` on Windows and Linux). It slides in from the right. Close it with `Esc` and open it again later: the chat is still there. The **Helper** screen shows the same chat.

1. Type in the box that says **Ask the Stack**, or click one of the suggestions.
2. Press `Enter`.

The first message takes a few seconds while the Helper wakes up. After 5 idle minutes it goes back to sleep and frees its memory. You can change that wait in Settings, under **Keep the Helper ready**. It is never less than 1 minute.

It knows the Stack's words. A **feature** (also called a role) is a job, like Chat, Coding, Images or Voice out. An **engine** is the program that runs a model, like llama-server or Splash. A **model** is the big file the engine holds in memory. A **tier** is how big a model a feature may use: Reduced, Standard, Boost or Max. A short follow-up such as "what about max" means the same feature as your last question. If you ask for a size, the answer is in GB.

These shortcuts work too:

- `/health` asks if everything is healthy.
- `/memory` asks how much memory is free.
- `/restart` asks it to restart the Stack.
- `/new` clears the chat.

## Changes need your confirm

The Helper reads health, features, models, memory, logs, settings and updates on its own. To change something, it shows a card in the chat. The card has one sentence about what will happen, each value that changes (for example Video: On to Off), and two buttons: **Confirm** and **Cancel**. Nothing changes until you click **Confirm**. A card waits 10 minutes.

You can ask for things like:

- "Turn video off."
- "Move music above voice out."
- "Apply the recommended profile."
- "Restart the voice out engine."

If your words could mean two things, the Helper asks one short question instead of guessing. For example "move music above speech" gets "Do you mean Voice in or Voice out?"

It can switch a feature on or off, change a feature's priority, apply the recommended profile, change a setting, restart an engine or the Stack, check for updates, apply one, or go back. It does not restart the computer, remove models, edit files, run commands, change the admin password or sign-in settings, or read secrets. For a restart of the computer use the **Tools** screen, and to remove a model use the **Models** screen.

## Clear the chat

Click **Clear**. The messages are deleted from the Stack's database and anything waiting for a confirm is dropped.

## Still need help?

Read [If something is not working](fix-a-problem.md).
