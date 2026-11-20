# H3 video pin

The Stack pins the MiniMax H3 video engine source at commit `55bb7ddd015321a25385683419951e7c7f518775`, verified by the source archive SHA-256. The 39 supplied published files are pinned with their source repository, full revision, size and SHA-256. The brief calls for 36 weight files, but the supplied verified manifest contains 39 files, so all 39 are represented in this pin.

The 4-bit-pruned-stream2 transformer and `minimax_h3_turbo_v4_step600_ema.safetensors` have no published source. two files on existing installs have no published source; they keep working there and are not offered elsewhere.

The Stack recognizes an existing H3 install by checking the published pinned files under its models folder, using file size and SHA-256. It reports a complete match as an adopted existing install and reports missing or differing files as existing, not verified. It does not modify that folder.

`MAIPAI_H3_VIDEO_HOME` continues to select the runtime folder. This is a softer rule than ignored until a pinned part replaces what a hub runs: the existing install keeps working while its folder is recognized, and new installs use only the published pinned files.

`pinned` means the published files are all present and verified; it does not mean the engine can run. Runtime readiness is separate (the video model paths and the engine's own checks), so never read `pinned` or `adopted_existing` as "runnable".

The status check reads the folder with synchronous file calls. On an unmounted or stalled volume a stat can hang the caller until the volume answers, so a caller that must stay responsive should run it off the request path. A variable that points at a folder that does not exist reads `missing`.

Real cold timings and a real download have not been measured.

## Swap runner pin data (H3-PIN-01 b, data only)

`backend/src/packs/h3/swapPins.ts` holds the pin data for the head and character swap runner: the upstream source revision, the reference bundle's files (repository, revision, size, SHA-256) and the two adapters (revision not recorded, so a builder pins the current one and compares the hashes). It is data only: no download, build or install exists, and the swap routes stay private testing. The runner's local patch is not in this repository.

Before any swap runner, bundle or adapter is published, made a default or offered for install, all of these must be true: a clean reproducible rebuild with the flags recorded; the licences of the bundle and both adapter repositories read and written down; the owner's yes. Until then a household cannot install head or character swap.
