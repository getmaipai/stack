// ENGINE-MLX-01 smoke: the real engine on a real Mac, through the Stack's
// own code. Builds the oMLX environment from the hashed requirements file,
// pulls the pinned MLX model through the verified installer (every file's
// sha256 checked), starts chat through the supervisor, and exercises the
// public route: a completion with reasoning, a streamed one with timings,
// a tool call, json_schema output, a picture, token counting, the failure
// of the process, and a clean stop. Several GB of downloads and about 20 GB
// of memory, so it runs only when asked:
//
//   OMLX_SMOKE=1 bun test tests/omlxSmoke.test.ts --timeout 3600000
//
// It never touches the live Stack: the test preload gives it a scratch data
// directory, and every engine it starts is stopped in `afterAll`. The GPU
// part holds the shared bench lock (mkdir /private/tmp/claude-501/bench.lock)
// and stays under ten minutes.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmdirSync } from "node:fs";
import { app } from "@/app";
import { ensureOmlxEnvironment, omlxInstalled } from "@/chat/omlx";
import { startModelInstall } from "@/lib/installJobs";
import { getModel } from "@/lib/modelStore";
import { STACK_CHAT_MUSE_30B_MLX_MODEL, STACK_CHAT_MUSE_30B_XL_MODEL } from "@/lib/modelCatalog";
import { chatEngine, getProcess, runningEngine, setMachineTier, stopAllRoles, identityCheck, getRoleStatus } from "@/lib/supervisor";
import { upsertModel } from "@/lib/modelStore";
import { deflateSync } from "node:zlib";

/** A solid red PNG of the given size, made here: the model reads a picture of 64 pixels or more reliably (llama-server answers "white" for the 16 pixel probe too). */
function redPng(side: number): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (bytes: Buffer) => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const body = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(side, 0); header.writeUInt32BE(side, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: side }, () => [255, 0, 0]).flat())]);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: side }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

const LOCK = "/private/tmp/claude-501/bench.lock";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function withGpuLock<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { mkdirSync(LOCK); break; } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST" || attempt >= 180) throw error;
      await sleep(30_000);
    }
  }
  try { return await work(); } finally { try { rmdirSync(LOCK); } catch { /* already gone */ } }
}

afterAll(async () => { await stopAllRoles("smoke finished").catch(() => {}); });

const chat = async (body: Record<string, unknown>) => {
  const response = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "chat", ...body }) });
  return { response, json: (await response.clone().json().catch(() => null)) as Record<string, any> | null, text: await response.text() };
};

test.skipIf(!process.env.OMLX_SMOKE)("the oMLX chat engine, end to end on this Mac", async () => {
  // 1. The environment, from the hashed file.
  const builtAt = Date.now();
  if (!omlxInstalled()) await ensureOmlxEnvironment((phase) => console.log(`[smoke] building ${phase}`));
  expect(omlxInstalled()).toBe(true);
  console.log(`[smoke] environment ready in ${Math.round((Date.now() - builtAt) / 1000)} s`);

  // 2. The model, through the verified installer (every file's sha256).
  const pulledAt = Date.now();
  const { done } = startModelInstall(STACK_CHAT_MUSE_30B_MLX_MODEL as never, "chat");
  await done;
  const record = getModel(STACK_CHAT_MUSE_30B_MLX_MODEL.id)!;
  expect(record.modelPath).toMatch(/Muse-Glimmer-30B-4bit$/);
  expect(record.verifiedAt).toBeTruthy();
  console.log(`[smoke] model verified in ${Math.round((Date.now() - pulledAt) / 1000)} s at ${record.modelPath}`);
  // The GGUF record the fallback would use (never loaded here).
  upsertModel({ id: STACK_CHAT_MUSE_30B_XL_MODEL.id, roles: ["chat"], source: "catalog", provenance: {}, revision: "r", sha256: "d".repeat(64), licence: "Apache-2.0", verifiedAt: new Date().toISOString(), modelPath: "/tmp/never/muse.gguf", sizeBytes: 19_653_960_832, engineRequirements: { engine: "llama-server" } });

  setMachineTier("p128");
  expect(chatEngine()).toBe("omlx");

  await withGpuLock(async () => {
    // 3. Start through the supervisor: health, identity, the post-load check, the picture check.
    const startedAt = Date.now();
    const processRecord = await getProcess("chat");
    console.log(`[smoke] chat ready in ${Math.round((Date.now() - startedAt) / 1000)} s, pid ${processRecord.pid}`);
    expect(processRecord.engine).toBe("omlx");
    expect(runningEngine("chat")).toBe("omlx");
    expect(processRecord.identity).toMatchObject({ build: "omlx-0.7.0", model: "Muse-Glimmer-30B-4bit", healthy: true });
    expect(processRecord.imageInput).toBe(true);
    expect(identityCheck("chat")).toMatchObject({ ok: true });
    expect(getRoleStatus("chat").postLoadCheck?.replyOk).toBe(true);
    expect(processRecord.contextLength).toBe(131072);

    // 4. The public route: a completion carries the engine's headers, reasoning and timings.
    const plain = await chat({ messages: [{ role: "user", content: "Say hello in five words." }], max_tokens: 400 });
    expect(plain.response.status).toBe(200);
    expect(plain.response.headers.get("x-maipai-engine")).toContain("omlx-0.7.0");
    expect(plain.response.headers.get("x-maipai-model")).toBe("Muse-Glimmer-30B-4bit");
    const message = plain.json!.choices[0].message;
    expect((message.content ?? "").length).toBeGreaterThan(0);
    expect(typeof message.reasoning_content).toBe("string");
    expect(plain.json!.timings.predicted_per_second).toBeGreaterThan(10);

    // 5. Streaming: reasoning first, the usage chunk last with timings.
    const streamed = await chat({ stream: true, messages: [{ role: "user", content: "Name two colours." }], max_tokens: 400 });
    const events = streamed.text.split("\n").filter((line) => line.startsWith("data: ") && line !== "data: [DONE]").map((line) => JSON.parse(line.slice(6)));
    const usageChunk = events.find((event) => event.usage);
    expect(usageChunk.timings.predicted_per_second).toBeGreaterThan(10);
    expect(events.some((event) => event.choices?.[0]?.delta?.reasoning_content)).toBe(true);
    expect(events.some((event) => event.choices?.[0]?.delta?.content)).toBe(true);

    // 6. A tool call in the engine's native shape.
    const tools = [{ type: "function", function: { name: "math", description: "Evaluate an arithmetic expression.", parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] } } }];
    const called = await chat({ messages: [{ role: "user", content: "What is 1234*5678? Use the math tool." }], tools, max_tokens: 600, temperature: 0 });
    expect(called.json!.choices[0].message.tool_calls[0].function.name).toBe("math");
    expect(JSON.parse(called.json!.choices[0].message.tool_calls[0].function.arguments).expression).toContain("1234");

    // 7. json_schema output (xgrammar, without torch).
    const schema = { name: "s", strict: true, schema: { type: "object", properties: { suggestions: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 }, mood: { type: "string", enum: ["happy", "neutral", "sad"] } }, required: ["suggestions", "mood"], additionalProperties: false } };
    const structured = await chat({ messages: [{ role: "user", content: "Three follow-up questions about lighthouses, and the mood." }], max_tokens: 500, temperature: 0.3, response_format: { type: "json_schema", json_schema: schema } });
    const parsed = JSON.parse(structured.json!.choices[0].message.content);
    expect(parsed.suggestions.length).toBe(3);
    expect(["happy", "neutral", "sad"]).toContain(parsed.mood);

    // 8. A picture.
    const picture = await chat({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: redPng(128) } }, { type: "text", text: "What colour fills this picture? One word." }] }], max_tokens: 400, temperature: 0 });
    expect(`${picture.json!.choices[0].message.content}${picture.json!.choices[0].message.reasoning_content}`.toLowerCase()).toContain("red");

    // 9. Token counting through the public route: the engine's own template and tokenizer.
    const counted = await app.request("/v1/tokenize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "chat", messages: [{ role: "system", content: "You are Clover." }, { role: "user", content: "Hello there" }] }) });
    expect(counted.status).toBe(200);
    const count = ((await counted.json()) as { count: number }).count;
    expect(count).toBeGreaterThan(10);
    expect(count).toBeLessThan(200);

    // 10. The process dies hard: the Stack sees it, and the next request starts a fresh one.
    process.kill(processRecord.pid!, "SIGKILL");
    for (let wait = 0; wait < 50 && getRoleStatus("chat").state !== "offline"; wait++) await sleep(200);
    expect(getRoleStatus("chat").state).toBe("offline");
    const again = await chat({ messages: [{ role: "user", content: "Say hi." }], max_tokens: 300 });
    // The Stack backs off a crashed start for a few seconds; the answer is either the new engine's or a clear refusal, never a hang.
    expect([200, 503]).toContain(again.response.status);

    // 11. A clean stop leaves nothing behind.
    await stopAllRoles("smoke finished");
    expect(runningEngine("chat")).toBeNull();
  });
}, 3_600_000);
