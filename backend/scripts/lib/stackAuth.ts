// ISOLATION-04: the Stack refuses a write without Home's token. A script that talks to a running Stack imports this file first; every
// non-read fetch then carries the token, read from STACK_HOME_VIEW_TOKEN or from <STACK_DATA_DIR>/keys/home-view-token (the data folder
// of the Stack it talks to; set STACK_DATA_DIR to it, for the live Stack /usr/local/maipai-home/stack/data).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function token(): string | null {
  const env = process.env.STACK_HOME_VIEW_TOKEN?.trim();
  if (env && env.length >= 16) return env;
  const dir = process.env.STACK_DATA_DIR;
  const file = dir ? join(dir, "keys", "home-view-token") : null;
  return file && existsSync(file) ? readFileSync(file, "utf8").trim() : null;
}

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const key = method === "GET" || method === "HEAD" ? null : token();
  if (!key) return realFetch(input, init);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("x-maipai-home-token", key);
  return realFetch(input, { ...init, headers });
}) as typeof fetch;
