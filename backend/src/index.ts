import { app } from "@/app";

const port = Number(process.env.PORT ?? 8770);

Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch: app.fetch,
});

console.log(`Health: http://127.0.0.1:${port}/healthz`);
console.log(`Docs: http://127.0.0.1:${port}/api/docs`);
