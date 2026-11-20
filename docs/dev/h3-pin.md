# H3 video pin

The Stack pins the MiniMax H3 video engine source at commit `55bb7ddd015321a25385683419951e7c7f518775`, verified by the source archive SHA-256. The 39 supplied published files are pinned with their source repository, full revision, size and SHA-256. The brief calls for 36 weight files, but the supplied verified manifest contains 39 files, so all 39 are represented in this pin.

The 4-bit-pruned-stream2 transformer and `minimax_h3_turbo_v4_step600_ema.safetensors` have no published source. two files on existing installs have no published source; they keep working there and are not offered elsewhere.

The Stack recognizes an existing H3 install by checking the published pinned files under its models folder, using file size and SHA-256. It reports a complete match as an adopted existing install and reports missing or differing files as existing, not verified. It does not modify that folder.

`MAIPAI_H3_VIDEO_HOME` continues to select the runtime folder. This is a softer rule than ignored until a pinned part replaces what a hub runs: the existing install keeps working while its folder is recognized, and new installs use only the published pinned files.

`pinned` means the published files are all present and verified; it does not mean the engine can run. Runtime readiness is separate (the video model paths and the engine's own checks), so never read `pinned` or `adopted_existing` as "runnable".

The status check reads the folder with synchronous file calls. On an unmounted or stalled volume a stat can hang the caller until the volume answers, so a caller that must stay responsive should run it off the request path. A variable that points at a folder that does not exist reads `missing`.

Real cold timings and a real download have not been measured.
