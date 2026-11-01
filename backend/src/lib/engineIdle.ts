// ENGINE-IDLE-01: how long a generator's worker stays loaded after its last job.
// One reader for the video, picture and music workers, so the timer, the governor's
// idle limit and the status routes all say the same number. The setting is
// `stack.engines.<role>.keep_warm_minutes`; a VIDEO_IDLE_MS / IMAGE_IDLE_MS /
// MUSIC_IDLE_MS environment variable (milliseconds) wins, for tests and scratch runs.
import { settingValues } from "@/settings";

export type IdleRole = "video" | "music" | "image";
/** Video models are 40 GB and more, so video leaves after 2 minutes: long enough for a back-to-back second clip. */
export const ENGINE_IDLE_DEFAULT_MINUTES: Record<IdleRole, number> = { video: 2, music: 5, image: 10 };
const ENV_NAME: Record<IdleRole, string> = { video: "VIDEO_IDLE_MS", music: "MUSIC_IDLE_MS", image: "IMAGE_IDLE_MS" };

export function engineIdleMs(role: IdleRole): number {
  const fromEnv = process.env[ENV_NAME[role]];
  if (fromEnv !== undefined && fromEnv !== "" && Number.isFinite(Number(fromEnv))) return Number(fromEnv);
  const minutes = Number(settingValues()[`stack.engines.${role}.keep_warm_minutes`]);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : ENGINE_IDLE_DEFAULT_MINUTES[role]) * 60_000;
}
