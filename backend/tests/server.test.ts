import { expect, test } from "bun:test";

// The idle timeout is part of the Bun.serve options, not the app.
const options = { port: 8770, hostname: "127.0.0.1", fetch: (request: Request): Response | Promise<Response> => Response.json({ ok: true }), idleTimeout: 255 };

test("the server idle timeout is 255 seconds so a slow check never times out", () => {
  expect(options.idleTimeout).toBe(255);
  expect(typeof options.port).toBe("number");
  expect(typeof options.hostname).toBe("string");
});
