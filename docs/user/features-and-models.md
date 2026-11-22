# Choose features and models

You decide which jobs the Stack does, which model does each job, and who gets memory first when it runs short.

## The features

| Feature | What it does |
|---|---|
| Chat | Answers questions in conversation. |
| Coding | A larger model for code. Loads when asked. |
| Judge | A small, fast model for quick answers. |
| Router | Picks which model should answer. |
| Embeddings | Turns text into numbers so it can be searched. |
| Re-rank | Sorts search results by how well they match. |
| Vision | Reads pictures. |
| Voice in | Turns speech into text. |
| Voice out | Turns text into speech. |
| Wake word | Listens for a trigger phrase on a paired device. |
| Images, Video, Music | Make pictures, clips and songs. Load when asked. |
| Helper | The admin page's own assistant. See [the Helper](helper.md). |

## One page for features and models

Open **AI and models**. It is the same page MaiPai Home shows, so a choice you make here shows up there at once, and the other way around. It takes about 5 minutes the first time.

The top of the page says how much memory your computer has for AI and how much disk is free. Below it is one card for each feature, with the model it uses, its size and a one-line status (Ready, Downloading 42%, Needs a look, Off).

## Turn a feature on or off

1. Use the switch on the feature's card.
2. Read the line the page shows. It says what happened in a sentence.

A feature that is off does not start and uses no memory. If someone asks for it, the Stack says it is off.

## Find a model

Type in the search box. It matches a model's name, version, precision, licence and description, and the feature's name. "3.8" finds version 3.8 and not version 3 or 8. The top bar's search (`Command` and `K`) finds models the same way.

## Choose a model

1. Click a feature's card.
2. Under **Which model each level uses**, pick a model for Reduced, Standard, Boost or Max. A feature with one model has one choice.
3. If the model is not on this computer yet, the Stack starts the download first and uses the model when it is ready. Big models take a while. You can watch the progress on the card.

Every download comes from a pinned address and is checked against a checksum before the Stack uses it. To get a model without using it yet, click **Download** beside it. **Remove** deletes it.

A model that does not fit this computer's memory is refused with the reason in a sentence.

## Use the recommended setup

1. Click **Recommended setup**.
2. Read what would change. Nothing is saved yet.
3. Click **Use the recommended setup** to save it. The Stack starts the downloads it needs. It never removes anything.

## Free up space

When models are downloaded but nothing uses them, **Free up** appears with the size you would get back. Tick what to remove and confirm. You can download any of them again later.

## Add a chat model

Under **More**, click **Add a chat model** and paste a link to a model on Hugging Face. The Stack checks its size and licence first and says in a sentence if it cannot use it.

## Set the order

When memory is tight, features wait in line. Under **More**, **Which feature goes first** sets who is served first. Use the up and down buttons.

## Check what fits this computer

At the bottom, **Setup for this computer** shows which ready-made size (16, 32, 64 or 128 GB and up) matches your memory and what each feature would do on it. **Use Matched** applies the ready-made setup. **Keep my own choices** checks your choices for fit and turns nothing on or off for you.

## Still need help?

Read [If something is not working](fix-a-problem.md).
