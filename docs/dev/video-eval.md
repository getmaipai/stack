# Video evaluation harness

Run the harness against an already running Stack. The caller chooses a run label, output folder, and lock folder:

```sh
bun scripts/bench/video-eval.ts --stack http://127.0.0.1:8771 --out /tmp/video-eval/run-a --run run-a --lock /tmp/video-eval/lock
```

The runner submits one clip at a time through the generic make route, waits for completion, and reads each clip receipt. Use `--suite` to select another validated suite, `--only` for row ids, `--skip-private` to omit private rows, `--previous` to compare with a prior `run.json`, and `--scores` to join human ratings by row id. A lock folder already owned by another run blocks startup. The runner removes a lock it created when it exits or receives SIGINT.

The output folder receives `run.json` and `run.md`, with `delta.md` when `--previous` is supplied. The reports contain timings and measured receipt facts. The checker is `not_run` because the Stack has no route to start a clip check on the delivered file. Outputs belong outside the repository and should stay out of commits.

H3 rows are marked `private_testing` because their licence excludes some regions. They are never default arms. Pass `--skip-private` to omit them.
