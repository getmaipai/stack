# Update, and go back

There are two kinds of update: the engines and models the Stack runs, and the Stack itself. Both can be undone. Each takes about 5 minutes.

## Update an engine

1. Open **Updates**.
2. Click **Check now**. This reads the list of new versions from the internet. See [what leaves your computer](privacy.md).
3. Find an engine marked **Update available** and click **Update**.
4. Confirm. The engine stops, switches to the new build, and starts again. If the new build does not answer, the Stack keeps the old one.

You will know it worked when the card says "Up to date".

## Go back to the old engine

After an update, the Stack keeps the old build. On the **Updates** screen, click **Go back to** and the old version number, then confirm.

The button shows up after an update you made on this page, in the same browser. If you used another browser, ask the Helper, or see the [developer docs](../dev/admin-api.md) for the rollback route.

## Update the Stack itself

The Stack's own updates come from a release, like the first install. Use the script in the Stack's folder:

```
bash ~/.maipai-stack/install.sh update --tag v0.2.0
```

Replace `v0.2.0` with the release you want. The script downloads it, checks the checksum, switches over and restarts the Stack. If the new build does not answer within about 30 seconds, the script goes back to the old build by itself and tells you.

Your data is never touched by an update.

## Go back to the old Stack

```
bash ~/.maipai-stack/install.sh rollback
```

The old build comes back and the new one is kept. Run the same command again to return to the new one.

## Still need help?

Read [If something is not working](fix-a-problem.md).
