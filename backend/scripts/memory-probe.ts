import { getMemoryReader } from "@/lib/memory";

const reading = getMemoryReader().read();
const pressureProcess = Bun.spawn(["memory_pressure", "-Q"], { stdout: "pipe", stderr: "ignore" });
const pressureOutput = await new Response(pressureProcess.stdout).text();
await pressureProcess.exited;
const systemFreePercent = pressureOutput.match(/free percentage:\s*(\d+)%/i)?.[1] ?? "unavailable";
console.log(JSON.stringify(reading));
console.log(`memory_pressure free percentage: ${systemFreePercent}%`);
