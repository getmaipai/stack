# MaiPai Stack: the experience

Design for the pages a person sees. The rule from
`getmaipai/.github/docs/STYLE.md` applies to every word on them: the dad
test. A busy parent with basic tech knowledge reads it once and knows what
to do. Layout, kit and responsive rules come from
`getmaipai/.github/docs/UI.md`; the Stack's pages use `@maipai/ui` and
the lucide icon set, the same as Home, so the two products look like one
family and nothing is drawn twice.

Three people use the Stack, and the pages are ordered for the first one:

- **The operator**, who installed it. Wants green lights, a number for
  "how much can this machine do", and to try each thing once.
- **A client's author**, writing a tool against the API. Wants a key,
  the explorer at `/api/docs`, and the event feed.
- **Home**, which is a client and never sees these pages; it reads the
  same facts over the API and shows them in its own Admin.

## Install and first run (redesigned 2026-09-17)

The rule: a person is talking to their own AI within minutes of
opening the app, and a download speed never looks like our app. What
the well-liked products do: Ollama installs in thirty seconds and
downloads nothing until asked; Home Assistant asks for an account and
a name and adds everything heavy later; Apple Intelligence downloads
its models in the background with a "Preparing" state and a
notification when ready; Jan redesigned to "chatting in seconds" with
a small model and background preparation. LM Studio offers a 6 GB
download during onboarding and its bug tracker has people giving up
after an hour on a blank screen.

**Install** is one download and one open: the app bundle with the
daemon inside. No terminal, no package manager, no Docker.

**First run is three steps and downloads nothing**, under ninety
seconds, a progress rail on the left, a "back" that always works:

1. **Welcome.** "MaiPai Stack runs AI on this computer. Nothing leaves
   it." The AI-outputs disclaimer in plain words, once. Continue.
2. **Your login.** Operator password (passkey later). No email, no
   account anywhere else.
3. **This computer.** The probe as a card in the person's words
   ("Apple silicon Mac, 24 GB of memory, 153 GB free", never
   `darwin arm64`), and one line: "Ready. Let's set up your AI."

Then the board, ours, with one card on top: **Set up your AI.**

**The sizer, one screen.** The proposed plan for this machine in the
person's words (the tier label), a "Change" list of the four tiers,
each saying what it can and cannot do, and two buttons:

- **Start small now**: a fast chat model plus small voice in and out,
  about 1 GB, one to three minutes on ordinary broadband. The person
  is talking to their own AI before the full plan arrives.
- **Get the full plan**: queued behind the small set.

**Downloads are a background job with an honest bar**: one row per
model and engine with size, speed, time left, pause and resume, where
it comes from and its licence in one line, and one sentence that
separates us from the network: "This is your internet speed. The
Stack is ready; your bigger model is on its way." A notification when
it lands. If a download fails, the row says why in words ("The
internet dropped. Downloads resume when it is back.") and nothing
else stops.

**The feature selector is abilities, not models**: chat, voice,
pictures, video, music, each with its size and whether this machine
can run it, defaults from the tier; anything can be added later from
the board. Model names sit behind a "details" disclosure for
tinkerers.

**Try it** opens the moment the small model lands, so the first
impression is a conversation, not a progress bar.

## The board

The home page, and what the menu-bar item opens. A grid of role tiles,
each a status and one line:

| Tile | Green | Yellow | Grey | Red |
|---|---|---|---|---|
| Chat | "Ready, 62 GB loaded" | "Loading" | "Off" | "Stopped: <reason>" |
| Coding | same | | | |
| Voice in / Voice out | "Ready" | | | |
| Pictures / Video / Music | "Ready when asked" (on-demand) | "Working, 40%" | "Not installed" | |
| Memory | "78 of 128 GB in use, 30 GB free for jobs" | "Tight: a picture job will wait" | | "Over: something was unloaded" |

Under the tiles: the last five notifications, and a "Repairs" list if the
Stack noticed anything (a model whose checksum no longer matches, an
engine that crashed twice, a managed host that vanished), each with the
one action that fixes it.

## Try it

One page, one tab per role the profile can serve. Every tab is stateless
and says so ("This box forgets when you leave it. For a real assistant
that remembers, install MaiPai Home.").

- **Chat**: a streaming reply box. Under each reply, in small text: the
  engine, the model, first-token time, tokens per second.
- **Speak**: type a sentence, hear it. Voice picker for the installed
  voices. Latency shown.
- **Listen**: a mic button, live words as they arrive.
- **Picture, Video, Music**: a prompt, a quality choice (fast, everyday,
  best), a progress bar, the result, and the memory delta the job caused.
  Before the first generation, the one-time adult acknowledgment: one
  clear dialog, one confirmation, never again.

Nothing here is saved. The point is that a person, or a tool's author,
can prove each role works in under a minute.

## Models

A list, one row per installed model: name, roles it serves, size on disk,
measured loaded size, licence, source and revision, last used, and its
state (resident, loaded now, on demand, pinned). Row actions: pin, unload,
remove, "check for update". An "Add" button opens the Catalog's model
packages first (signed, provenance filled in), and a "from a URL or
Hugging Face" option for the operator, which fills the provenance record
before the model turns on. Multi-select with remove and clear-all, per the
org's batch rule.

## Engines

The same shape for engines: build, platform, kind (spawned, managed,
url), which roles it holds, health, last restart and why, a log link. A
managed host shows its probe result and `offline_reason` in words when it
is gone ("ComfyUI is not running. Start it and this row turns green.").

## Hardware and memory

The probe card, the chosen profile with a "Change" link, the governor's
rules stated as sentences ("One picture or video job at a time. A job
waits when less than 20 GB is free."), and a live bar of what is loaded
with each model's measured share. This is the page that answers "what
can this machine do" honestly, and every number on it was measured on
this machine.

The profile names resident and on-demand models; measured peaks replace
file-size estimates after the first-run bench, and estimates are labeled
`(estimated)`. An on-demand load starts only when free memory after its
requested peak leaves the tier's working margin: 4 GB on p16, 8 GB on p32,
12 GB on p64, or 20 GB on p128. One generator runs at a time; a request
waits in a four-place queue or is refused with a reason. A JIT model
expires after 600 seconds idle, and pressure unloads the least recently
used unpinned JIT model; a pinned model never unloads. The cap is total
memory minus the 8 GB OS margin, and `keep_alive` extends idle time only
within that cap and never for generators.

## Clients and keys

A row per client: name, key prefix, allowed roles, counters, created,
last seen, revoke. "New client" asks for a name and the roles, shows the
key once, and offers a copy button. Home appears here as a client the
day it installs, with its roles already chosen.

## Updates

Three sections: the Stack, engines, models. Each shows the installed
version and, if checking is on, what is available with release notes.
"Update" drains the role, swaps, and keeps the old build; "Roll back" is
one click until the next update. Checking is off until the operator turns
it on, and the page says what the check sends (a version number, nothing
else).

## Notifications

The event feed in words, newest first, grouped by day: updates, repairs,
jobs finished, pressure warnings. Clear-all. The menu-bar badge counts
unread.

## Settings

Few. Port and LAN exposure (off by default, a warning when on, a key
required). The update check switch. The idle timeout for on-demand
models. Log level. Language. Each setting is declared once in the
settings definition and rendered by the generic renderer, per
`getmaipai/.github/docs/SETTINGS.md`, so the page is never hand-built.

## Share with your family: the Home hand-off

The card that appears on the Ready step and stays on the board until Home
is installed. Wording:

> **Share with your family.** The Stack is yours alone. MaiPai Home adds
> people, kid-safe profiles, memory, and companions on top of it, on this
> same computer. [Install MaiPai Home]

That button is the answer to "can my kid use this": the Stack never gets
an "Add a person" button, so the operator is never left looking for one.
The install puts Home beside the Stack, registers Home as a client with
its roles, and hands the operator to Home's own first run, where the
household is created. Nothing is imported, because there is nothing to
import.

## The menu bar (macOS, after the web UI)

A small native item: the board's overall state as the icon, a menu with
each role's one line, "Open the Stack", "Pause everything" (drains the
roles and unloads, for when the machine is needed for something else),
"Resume". No chat in the menu bar; that is Desktop's job.

## Copy rules for this repo

The org's writing standards apply. In addition, on every Stack page:
memory numbers are measured or absent; an error names what to do next;
a model is named only after its role; and no page mentions a person,
because the Stack has none.
