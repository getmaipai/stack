# Ask the Helper a question

The Helper is a small assistant on the admin page. It answers questions about your computer's Stack, like "Is everything healthy?" or "How much memory is free?". When a change is needed, it asks first. It takes about 3 minutes to set up.

The Helper has its own model, so it works even when chat is broken. It does not use the internet, and your questions stay on this computer.

## Install it

1. Open **Helper**.
2. Click **Install the Helper (about 2.5 GB)**. The download is checked against a checksum before it is used.
3. Wait. The chat opens by itself when the download is done.

## Ask something

1. Type in the box that says **Ask the Stack**, or click one of the suggestions.
2. Press `Enter`.

The first message takes a few seconds while the Helper wakes up. After 5 idle minutes it goes back to sleep and frees its memory. You can change that wait in Settings, under **Keep the Helper ready**. It is never less than 1 minute.

These shortcuts work too:

- `/health` asks if everything is healthy.
- `/memory` asks how much memory is free.
- `/restart` asks it to restart the Stack.
- `/new` clears the chat.

## Changes need your click

The Helper can read health, features, memory, logs, settings and updates on its own. To change something, it shows a box with a sentence about what it will do, and two buttons: **Approve** and **Deny**. Nothing changes until you click **Approve**.

It can switch a feature on or off, change a setting, restart an engine or the Stack, check for updates, apply one, or go back. It cannot restart the computer, edit files, run commands, change the admin password or sign-in settings, or read secrets.

## Clear the chat

Click **Clear**. The messages are deleted from the Stack's database and anything waiting for approval is dropped.

## Still need help?

Read [If something is not working](fix-a-problem.md).
