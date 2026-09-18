# Open the Stack app

The first release of MaiPai Stack ships the desktop app alongside the
daemon. **Open the Stack app** to get the local console in a native window,
with a menu-bar item for health, Pause everything, Resume and Open.

The app attaches to the daemon managed by the operating system. Closing the
window does not stop the Stack, and a browser can still open the same local
console at `http://127.0.0.1:8770`.

This desktop app arrives with the first release. Until then, run the daemon
with `bun start` from the repository root and use the browser console.

## The first time you open the app

The app checks the local daemon. If it is not running, the bundled daemon
installs its LaunchAgent under `~/Library/LaunchAgents`, starts it, and opens
the console. Later launches attach to the existing service. Closing or
quitting the app leaves the Stack running.

## Uninstall

Choose **Uninstall the Stack…** from the menu bar item and confirm twice. This
removes the service and the Stack data directory. The command-line uninstall
without `--remove-data` keeps the data for a later install.
