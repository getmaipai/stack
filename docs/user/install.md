# Install the Stack

You install the Stack with one script. It downloads one file, checks it, starts the Stack, and tells you where to go next. It takes about 5 minutes.

## What you need

- A Mac with Apple Silicon. Linux is built but not tested yet. Windows is not supported.
- [Bun](https://bun.sh), which the voice engine needs.
- A release of the Stack. None is published yet, so [make one yourself](#make-a-release-yourself) first.

## Install

1. Open Terminal.
2. Go to the Stack folder. Run `cd` and then the path to your checkout of the Stack.
3. Run this, with the release name in place of `v0.1.0`:

```
bash scripts/install.sh install --tag v0.1.0
```

The script downloads two files from the release: `SHA256SUMS` and the Stack's `.tar.gz`. It checks the checksum before it unpacks anything. If the checksum does not match, nothing is installed.

When it finishes, it prints the admin page address and where the setup code is. The address is `http://127.0.0.1:8770/admin/`.

Next: [sign in for the first time](sign-in.md).

## Where things go

The Stack lives in `~/.maipai-stack`. Your data (models, settings, keys) is in `~/.maipai-stack/data`. Updating or going back never touches that folder.

To use another folder or port, add `--prefix <folder>` or `--port <number>` to the command.

## Make a release yourself

A release is two files: the build and its checksum list. This makes them in `release/`. It does not publish anything.

```
bash scripts/release-stack.sh v0.1.0
```

Then put them in a folder named for the release, and point the installer at the parent folder:

```
mkdir -p ~/stack-site/v0.1.0
cp release/* ~/stack-site/v0.1.0/
STACK_RELEASE_BASE_URL=file://$HOME/stack-site bash scripts/install.sh install --tag v0.1.0
```

Making a release compiles the Stack, so it needs the sibling folders `getmaipai/commons` and `getmaipai/.github` next to the Stack folder. The [installer notes](../dev/installer.md) list everything.

## Check it, or take it off

```
bash ~/.maipai-stack/install.sh status
bash ~/.maipai-stack/install.sh uninstall
```

`uninstall` removes the Stack and keeps your data. Add `--remove-data` to delete the data too. That cannot be undone.

## Still need help?

Read [If something is not working](fix-a-problem.md).
