# The installer and the release flow

Two scripts, both in `scripts/` (ADMIN-10): `release-stack.sh` makes a release, `install.sh` installs, updates, rolls back and removes it. Neither tags, pushes or publishes anything. Publishing the files as a GitHub release is the owner's call, and no release exists yet. Home's own installer is a separate path, described in [integrations.md](../integrations.md#install-and-service-hand-off); this is for a Stack with no Home.

## Make a release

```
bash scripts/release-stack.sh v0.1.0
```

The tag must look like `v0.1.0` (letters, digits, dots, dashes and underscores only). The script runs `scripts/build-binary.sh` into a temporary folder (`SKIP_VERIFY=1` by default, since the live verify downloads models; run it by hand), then writes to `release/`:

- `maipai-stack-<tag>-<platform>-<arch>.tar.gz`, one folder inside holding the binary, `admin-ui/`, `migrations/`, `ort-wasm/`, `backend-src/` and a `VERSION` file.
- `SHA256SUMS`, one line per tarball. Lines for other platforms of the same tag are kept.
- `install.sh`, a copy of the installer.

`BUILD_DIR=<dir>` reuses an existing build and skips the compile. `RELEASE_DIR=<dir>` writes elsewhere. The build needs `bun`, and `scripts/build-binary.sh` expects the sibling `getmaipai/commons` checkout the backend's `file:` dependencies point at.

To publish, create a GitHub release for the tag on this repo and attach the tarball and `SHA256SUMS`. `install.sh` downloads from `https://github.com/getmaipai/stack/releases/download/<tag>/`. Set `STACK_RELEASE_BASE_URL` to use another host or a `file://` folder that holds `<tag>/SHA256SUMS` and the tarball.

## Install, update, roll back, remove

```
bash scripts/install.sh install --tag v0.1.0
bash ~/.maipai-stack/install.sh update --tag v0.2.0
bash ~/.maipai-stack/install.sh rollback
bash ~/.maipai-stack/install.sh status
bash ~/.maipai-stack/install.sh uninstall [--remove-data]
```

- **Download.** The only network use is `SHA256SUMS` and the tarball. The tarball's checksum is verified before anything is unpacked. `--sha256 <value>` pins it against a value you got elsewhere, which matters because the checksum list comes from the same host as the tarball.
- **Layout** under the prefix (default `~/.maipai-stack`, or `STACK_PREFIX`, or `--prefix`): `releases/<tag>/` holds one build each, `current` links to the running one, `previous` to the build before the last update, `data/` holds the Stack's data and is never touched by update or rollback.
- **Service.** `install` runs the binary's own `install-service`: a launchd agent `com.maipai.stack` on macOS, a `systemd --user` unit on Linux. The installer writes no unit. `STACK_SERVICE_LABEL` changes the label.
- **Update** points `previous` at the old build and `current` at the new one, restarts, and waits for `/healthz` for about 30 seconds. If it does not answer, `update` points `current` back, restarts, and exits with the reason. A passing update prunes every build except `current` and `previous`.
- **Rollback** swaps `current` and `previous`, so running it again returns.
- **First run.** After a healthy start the Stack writes `<data>/admin-setup-code` (mode 0600). `install` prints the admin address `http://127.0.0.1:<port>/admin/` and the file path.

Environment: `STACK_PREFIX`, `STACK_PORT` (default 8770), `STACK_RELEASE_BASE_URL`, `STACK_BUN_BIN` (the bun the stt worker runs through, found on `PATH` if unset), `STACK_SERVICE_LABEL`.

## Tests and what is untried

`backend/tests/standaloneInstall.test.ts` drives the scripts against a fake build and a `file://` release folder. The real macOS run (install, `/admin/` answers 200, update, rollback, a bad tag, a tampered checksum, uninstall) was done in a scratch prefix and port. The Linux systemd path is untried on a Linux machine. `PINNED_TAG` in `install.sh` is empty until the owner picks the first release tag. There is no `stack update` command in the binary: the engine pin-and-rollback code swaps engines, not the Stack's own binary.
