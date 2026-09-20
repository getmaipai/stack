// The Stack's one logger instance over core's createLogger: the file is
// <data>/logs/stack.log, rotated by size and age, secrets redacted.
import { createLogger } from "@maipai/core/src/log";
import { format } from "node:util";
import { logsDir } from "@/lib/paths";

export const logger = createLogger(logsDir, "stack");

export function log(message: string, ...args: unknown[]): void {
  logger.appendLine(format(message, ...args));
}
