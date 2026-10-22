// The Stack's one logger instance over core's createLogger: the file is
// <data>/logs/stack.log, rotated by size and age, secrets redacted.
import { createLogger } from "@maipai/core/src/log";
import { format } from "node:util";
import { logsDir } from "@/lib/paths";

export const logger = createLogger(logsDir, "stack");

/** Closed event names and fields used for Home mode audit records. These
 * records never carry text, process names or model names. */
export const STACK_LOG_EVENT_REGISTRY = {
  home_mode_switch_started: {},
  home_mode_switch_done: {},
  home_mode_switch_failed: { reason: ["unavailable", "start_failed", "check_failed", "stop_failed", "rollback_failed"] as const },
  home_mode_self_test: {},
} as const;
export type StackHomeModeLogEvent = keyof typeof STACK_LOG_EVENT_REGISTRY;
export type StackHomeModeLogReason = typeof STACK_LOG_EVENT_REGISTRY.home_mode_switch_failed.reason[number];
export function logHomeModeEvent(event: StackHomeModeLogEvent, reason?: StackHomeModeLogReason): void {
  logger.appendLine(JSON.stringify({ event, ...(reason ? { reason } : {}) }));
}

export function log(message: string, ...args: unknown[]): void {
  logger.appendLine(format(message, ...args));
}
