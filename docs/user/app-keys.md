# Let another program use the Stack

Another program on this computer can use the Stack if you give it an app key. It takes about 2 minutes. You need to be signed in to the admin page (see [Sign in for the first time](sign-in.md)).

Any program that can talk to an OpenAI-style service works the same way: it asks for a base address and an API key.

## Make a key

1. Open the admin page and click **Connections**.
2. Type a **Name** for the key, such as the program that will use it.
3. Tick what it may do: **Chat**, **Vision**, **Speech**, **Models list**. Give it only what it needs.
4. Click **Make a key**.
5. Copy the key now. It is shown once. The Stack keeps no copy it can show again.

You will know it worked when the new key appears in the list with "Never used."

## Put it in the program

1. Set the program's base address to `http://127.0.0.1:8770/v1`. The Connections page shows the exact address for your Stack.
2. Set its API key to the key you copied.
3. Ask it something. The key's row on the Connections page then says when it was last used and how many requests it sent.

The key works on this computer only. The Stack turns away a web page that tries to use it.

## What a key can and cannot do

- A key reaches only the model routes its scopes allow. It cannot change settings, read the admin page, install models or make more keys.
- It cannot use Home's priority. If chat is busy with Home, a key waits its turn.
- It is limited to 60 requests a minute and 2 at a time. If a program goes over, the Stack answers "too many requests" and says how long to wait, and Health shows a warning with the key's name.

## Stop a key

Click **Revoke** on its row and confirm. The program stops working at once. If a revoked key is still being used, Health shows a warning so you can find the program. Click **Remove** afterward to clear the row.

## If a program says "unauthorized"

- "does not know this app key": the key was copied short or wrongly. Make a new one.
- "was revoked": make a new key and put it in the program.
- "does not have the ... scope": make a new key with that box ticked.
- "cannot reach ...": the program asked for something keys cannot do, such as a pictures route. That one goes through Home.
