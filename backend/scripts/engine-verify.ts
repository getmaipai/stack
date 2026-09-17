import { spawn } from "bun";
import { detectHardware } from "@/lib/hardware";
import { ensureEngine, engineBinaryPath } from "@/lib/engineInstall";
import { selectEngineBinary } from "@/lib/engineCatalog";

const pin = selectEngineBinary(await detectHardware());
if (!pin) throw new Error("No pinned engine matches this machine");

let lastPercent = -1;
await ensureEngine(pin, (completed, total, label) => {
  const percent = total > 0 ? Math.floor((completed / total) * 100 / 10) * 10 : 0;
  if (percent !== lastPercent) {
    lastPercent = percent;
    console.log(`${percent}% ${label}`);
  }
});

const process = spawn([engineBinaryPath(pin), "--version"], { stdout: "pipe", stderr: "pipe" });
const [output, error] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text()]);
const code = await process.exited;
if (code !== 0) throw new Error(`${error.trim()} (exit ${code})`);
console.log([output, error].filter((part) => part.trim()).join("\n").trim());
console.log(`pin: ${pin.id}`);
