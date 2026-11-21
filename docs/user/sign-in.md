# Sign in for the first time

The first time, you pick the one admin password. You need the setup code that the installer saved for you. It takes about 2 minutes.

## What you need

- The Stack is installed and running.
- A browser on the same computer.

## Steps

1. Show the setup code. In Terminal, run:

```
cat ~/.maipai-stack/data/admin-setup-code
```

2. Open `http://127.0.0.1:8770/admin/` in your browser.
3. Click **First time here? Set up the admin**.
4. Paste the code into **Setup code**.
5. Type a password in **New password**, and again in **Type it again**. It must be at least 12 characters.
6. Click **Set password and sign in**.

You will know it worked when you see the Overview page with a card for each feature.

The code works once. After you set the password, the Stack deletes the code file. You get 5 tries per hour, so paste the code carefully.

## Signing in later

Open the same address and type the password. Wrong 5 times in a row, and the Stack makes you wait, up to 15 minutes. A sign-in ends after 30 minutes of no clicks, or after 12 hours.

## If you forget the password

Only someone at the computer can reset it. In Terminal, run:

```
STACK_DATA_DIR=~/.maipai-stack/data ~/.maipai-stack/current/maipai-stack-darwin-arm64 admin reset
```

This removes the admin account, signs everyone out, and writes a new setup code. Then repeat the steps above. Your features, models and settings stay as they were. On an Intel or Linux computer the file name ends differently: look in `~/.maipai-stack/current` for the name that starts with `maipai-stack-`.

## Open it from another device

The page opens on this computer only. If you use Tailscale, you can also open it from your own devices on your own Tailscale network. Turn on **Admin page over Tailscale** in Settings (switch on **Show advanced settings** first), then restart the Stack. It is never open to your home network, and it always asks for the password.

## Still need help?

Read [If something is not working](fix-a-problem.md).
