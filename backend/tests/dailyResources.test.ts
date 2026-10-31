import { stampEventLine } from "@/lib/log";
import { expect, test } from "bun:test";
import { dailyResources } from "@/lib/dailyResources";

test("daily resource counts use event timestamps and skip junk", () => {
  const lines = [
    '{"at":"2026-10-30T09:00:00-04:00","event":"engine.retired","role":"chat","cause":"memory-watchdog"}',
    '{"at":"2026-10-30T10:00:00-04:00","event":"engine.retired","role":"chat","cause":"stack-stopping"}',
    '{"at":"2026-10-30T11:00:00-04:00","event":"engine.retired","role":"tts","cause":"engine-update-drain"}',
    '{"at":"2026-10-30T12:00:00-04:00","event":"isolation.paused"}',
    '{"at":"2026-10-30T12:01:00-04:00","event":"isolation.resumed","paused_seconds":60}',
    '{"at":"2026-10-30T12:02:00-04:00","event":"isolation.resume_forced","paused_seconds":12}',
    '{"at":"2026-10-30T13:00:00-04:00","event":"memory.action","action":"unload-idle"}',
    '{"at":"2026-10-30T13:01:00-04:00","event":"chat.window","action":"shrink"}',
    '{"at":"2026-10-30T13:02:00-04:00","event":"chat.window","action":"restore"}',
    '{"at":"2026-10-30T13:03:00-04:00","event":"process.survivor","action":"SIGKILL"}',
    '{"at":"2026-10-30T13:04:00-04:00","event":"sweep.done","freed_bytes":11}',
    '{"at":"2026-10-30T13:05:00-04:00","event":"sweep.done","freed_bytes":22}',
    '{"at":"2026-10-30T13:06:00-04:00","event":"engine.restart_requested_by_canary"}',
    'junk',
    '{"at":"2026-10-31T08:00:00-04:00","event":"engine.retired","role":"chat","cause":"route-engines-restart"}',
    '{"at":"2026-10-31T08:01:00-04:00","event":"memory.action","action":"cancel-running"}',
  ];
  const result = dailyResources(lines, 3, new Date("2026-10-31T12:00:00-04:00"));
  expect(result).toEqual([
    { date: "2026-10-31", chat_restarts_by_cause: { "route-engines-restart": 1 }, engine_stops_by_cause: { "route-engines-restart": 1 }, pauses: 0, resumes: 0, forced_resumes: 0, paused_seconds: 0, memory_actions: { "cancel-running": 1 }, shrinks: 0, restores: 0, survivors_stopped: 0, sweeps: { runs: 0, freed_bytes: 0 }, canary_restarts: 0 },
    { date: "2026-10-30", chat_restarts_by_cause: { "memory-watchdog": 1 }, engine_stops_by_cause: { "memory-watchdog": 1, "stack-stopping": 1, "engine-update-drain": 1 }, pauses: 1, resumes: 1, forced_resumes: 1, paused_seconds: 72, memory_actions: { "unload-idle": 1 }, shrinks: 1, restores: 1, survivors_stopped: 1, sweeps: { runs: 2, freed_bytes: 33 }, canary_restarts: 1 },
    { date: "2026-10-29", chat_restarts_by_cause: {}, engine_stops_by_cause: {}, pauses: 0, resumes: 0, forced_resumes: 0, paused_seconds: 0, memory_actions: {}, shrinks: 0, restores: 0, survivors_stopped: 0, sweeps: { runs: 0, freed_bytes: 0 }, canary_restarts: 0 },
  ]);
});

test("event lines written by the Stack logger carry their time and are counted for that day", () => {
  const at = new Date(2026, 9, 31, 14, 5, 0);
  const line = stampEventLine(JSON.stringify({ event: "engine.retired", role: "chat", cause: "memory-watchdog", reason: "Restarted." }), at);
  expect(line.startsWith('{"event":"engine.retired"')).toBe(true);
  expect(JSON.parse(line).at).toBe(at.toISOString());
  expect(stampEventLine("plain text line", at)).toBe("plain text line");
  expect(stampEventLine(line, at)).toBe(line);
  const day = dailyResources([line], 1, at)[0]!;
  expect(day.chat_restarts_by_cause).toEqual({ "memory-watchdog": 1 });
});
