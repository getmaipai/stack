# Open the Stack app

The first release of MaiPai Stack ships the desktop app alongside the
daemon. **Open the Stack app** to get the local console in a native window,
with a menu-bar item for health, Pause everything, Resume and Open.

The app attaches to the daemon managed by the operating system. Closing the
window does not stop the Stack, and a browser can still open the same local
console at `http://127.0.0.1:8770`.

This desktop app arrives with the first release. Until then, run the daemon
with `bun start` from the repository root and use the browser console.
