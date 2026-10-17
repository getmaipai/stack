// A download for a role that already serves (the oMLX weights while chat runs
// on llama-server, a projector, an upgrade) is reported beside the role's
// state as `pending_install`; it never turns a ready role into an installing
// one, and the job names what it is for. Hermetic: jobs are created in memory.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetJobsForTests, createJob, finishJob, updateJob } from "@/lib/jobs";
import { installPurpose } from "@/lib/installJobs";
import { pendingInstall } from "@/routes/roles";

beforeEach(() => __resetJobsForTests());
afterEach(() => __resetJobsForTests());

type RoleRow = { id: string; state: { state: string }; pending_install: { job: string; model: string | null; purpose: string | null; percent: number } | null };
async function chatRow(): Promise<RoleRow> {
  const body = await (await app.request("/stack/v1/roles")).json() as { roles: RoleRow[] };
  return body.roles.find((role) => role.id === "chat")!;
}

test("the install job names its purpose: faster chat engine, picture reading, or a plain upgrade", () => {
  expect(installPurpose({ engine: "omlx" })).toBe("faster chat engine");
  expect(installPurpose({ engine: "llama-server", component: "projector" })).toBe("picture reading for chat");
  expect(installPurpose({})).toBe("model upgrade");
});

test("an active install job for chat shows as pending_install and leaves the role's own state alone", async () => {
  const before = (await chatRow()).state.state;
  const job = createJob({ kind: "model.install", role: "chat", totalBytes: 100, status: "downloading", input: { model: "muse-glimmer-30b-mlx-4bit", purpose: "faster chat engine" } });
  updateJob(job.id, { percent: 40, completedBytes: 40 });
  const during = await chatRow();
  expect(during.state.state).toBe(before);
  expect(["installing", "downloading", "notInstalled"].includes(during.state.state) && before === "ready").toBe(false);
  expect(during.pending_install).toEqual({ job: job.id, model: "muse-glimmer-30b-mlx-4bit", purpose: "faster chat engine", percent: 40 });
});

test("a finished or failed job, or one for another role, is not pending", async () => {
  const done = createJob({ kind: "model.install", role: "chat", input: { model: "a" } });
  finishJob(done.id, { ok: true });
  const failed = createJob({ kind: "model.install", role: "chat", input: { model: "b" } });
  finishJob(failed.id, { ok: false, reason: "no" });
  createJob({ kind: "model.install", role: "tts", input: { model: "c" } });
  expect(pendingInstall("chat")).toBeNull();
  expect(pendingInstall("tts")?.model).toBe("c");
  expect((await chatRow()).pending_install).toBeNull();
});
