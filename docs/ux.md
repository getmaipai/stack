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

## Install and first open (decided 2026-09-17, evening)

The owner's rule, after seeing the five-step wizard: no wizard. One
command installs, the full app opens, and the board itself shows what
to add. Ollama proved the shape; the products that make people click
through steps before they see anything are the ones people abandon.

**Install** is one line in Terminal, hosted by us, and downloads only
our own compiled binary from our own GitHub release (nothing from a
third party at install time; engines and models arrive later, when an
ability is chosen):

    curl -fsSL https://getmaipai.github.io/stack/install.sh | sh

The script puts the Stack under the person's home folder, registers
it with launchd so it starts at login, starts it, and opens the
browser on the board. Under a minute. The same script updates an
existing install. A downloadable app bundle with the menu-bar item is
the second path, later; it runs the same steps.

**The first screen is the full app.** No modal, no steps. The board:

- **This computer**, measured automatically and said in plain words
  ("Apple silicon Mac, 24 GB of memory, 153 GB free"), with the plan
  this machine can run and a "Change" link.
- **Add abilities**: cards for Chat, Voice, Pictures, Video and Music,
  each with its size, "can run" or "not on this computer", and an
  Install button; a "Start small" suggestion preselected (a fast chat
  model plus small voice in and out, about 1 GB) so one click starts a
  conversation within minutes. Model names sit behind a "details"
  disclosure for tinkerers.
- **Downloads** as a background job with the honest bar (size, speed,
  time left, pause, resume, source and licence in one line) and the
  sentence "This is your internet speed. The Stack is ready; your
  bigger model is on its way." A notification when a row lands.
- The status strip, notifications and Repairs as before, empty and
  calm on a fresh install.
- A one-line note the first time, dismissible: "MaiPai Stack runs AI
  on this computer. Nothing leaves it. The AI can be wrong, and it is
  never medical, legal, or professional advice."

**No login until it matters.** On this computer, on loopback, the
board opens without a password (Ollama has none either). The first
time the person creates a client key for a tool, or switches on LAN
access, the Stack asks them to set the operator password once, right
there, and the admin routes require it from then on. The adult
acknowledgment stays as one dialog before the first picture or video,
never a step.

**Try it** appears on the board the moment the small set lands, so
the first thing the person does with the Stack is talk to it.

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
