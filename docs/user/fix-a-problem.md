# If something is not working

Find what you see below. Each fix is short.

## If the admin page does not open

The Stack may not be running. In Terminal, run:

```
bash ~/.maipai-stack/install.sh status
```

If it does not say a running build, start the Stack, then reload the page:

```
STACK_DATA_DIR=~/.maipai-stack/data ~/.maipai-stack/current/maipai-stack-darwin-arm64 start
```

Still nothing? Read the last lines of `~/.maipai-stack/data/logs/stack.error.log`. If the page says it is not built, reinstall the Stack.

## If the password is wrong, or you are told to wait

Five wrong tries in a row lock sign-in for up to 15 minutes. Wait, then try again. If you forgot it, [reset it](sign-in.md#if-you-forget-the-password).

## If a feature says Not installed

Open **Models**, find the feature, and click **Download** on a model. When it says "Installed", try again.

## If everything is slow, or a feature will not start

Memory may be tight. Open **Resources**. If the badge says "Getting tight" or "Critical":

1. Turn off a feature you do not use, on the **Features** screen.
2. Move the features you need most to the top of **Priority** on the **Models** screen.
3. Or choose a smaller setup on **Models**.

## If an update broke something

Go back. [Update, and go back](update-and-go-back.md) shows how, for an engine and for the Stack.

## If something else looks wrong

1. Open **Health**. Each problem has a fix button.
2. Open **Tools** and click **Run the check**. It sends one small request through each feature and says which did not answer.
3. Ask the [Helper](helper.md).
4. Click **Download diagnostics** on **Tools**, and attach the zip to an issue. Secrets are removed first.

## Still need help?

Open an issue on the Stack's GitHub page and attach the diagnostics zip.
