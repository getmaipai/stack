import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const stdlib = new Set([
  "abc", "argparse", "array", "ast", "asyncio", "atexit", "base64", "builtins", "collections", "contextlib", "copy", "csv", "dataclasses", "datetime", "decimal", "enum", "errno", "fcntl", "fnmatch", "functools", "gc", "getopt", "glob", "hashlib", "heapq", "hmac", "html", "http", "importlib", "inspect", "io", "itertools", "json", "logging", "math", "operator", "os", "pathlib", "pickle", "platform", "queue", "random", "re", "select", "shutil", "signal", "socket", "sqlite3", "statistics", "string", "subprocess", "sys", "tempfile", "textwrap", "threading", "time", "traceback", "types", "typing", "unicodedata", "unittest", "urllib", "uuid", "wave", "weakref", "xml", "zipfile",
]);

const workers = [
  {
    name: "recorded speech",
    source: "../src/recordedSpeech/recorded_speech_worker.py",
    requirements: "../src/speech/recorded-speech.darwin-arm64.requirements.txt",
    // mlx is provided by mlx==; mlx_audio is provided by mlx-audio==.
    provided: ["mlx", "mlx_audio"],
  },
  {
    name: "voice conversion",
    source: "../src/voiceConvert/voice_convert_worker.py",
    requirements: "../src/voiceConvert/voice-convert.darwin-arm64.requirements.txt",
    // soulxsinger and preprocess are bundled by the pinned SoulX-Singer source archive.
    provided: ["soulxsinger", "preprocess"],
  },
  {
    name: "stems",
    source: "../src/stems/stems_worker.py",
    requirements: "../src/stems/stems.darwin-arm64.requirements.txt",
    // yaml is provided by pyyaml==.
    provided: ["yaml"],
  },
  {
    name: "beats",
    source: "../src/beats/beats_worker.py",
    requirements: "../src/beats/beats.darwin-arm64.requirements.txt",
    provided: [],
  },
];

function importedModules(source: string): string[] {
  const imports: string[] = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    const direct = trimmed.match(/^import\s+([A-Za-z_][\w.]*)/);
    const from = trimmed.match(/^from\s+([A-Za-z_][\w.]*)\s+import\b/);
    const module = direct?.[1] ?? from?.[1];
    if (module) imports.push(module.split(".")[0]!);
  }
  return [...new Set(imports)];
}

function requirementNames(contents: string): Set<string> {
  return new Set(contents.split("\n").flatMap((line) => {
    const match = line.match(/^\s*([A-Za-z0-9_.-]+)==/);
    return match ? [match[1]!.toLowerCase().replaceAll("_", "-")] : [];
  }));
}

test("worker imports are present in the pinned engine requirements", () => {
  for (const worker of workers) {
    const source = readFileSync(join(import.meta.dir, worker.source), "utf8");
    const requirements = requirementNames(readFileSync(join(import.meta.dir, worker.requirements), "utf8"));
    const allowed = new Set(worker.provided.map((name) => name.toLowerCase().replaceAll("_", "-")));
    const missing = importedModules(source).filter((name) => {
      const normalized = name.toLowerCase().replaceAll("_", "-");
      return !stdlib.has(name) && !requirements.has(normalized) && !allowed.has(normalized);
    });
    expect(missing, `${worker.name} imports without a pinned provider`).toEqual([]);
  }
});

test("recorded speech worker renders without a reference clip (the default voice)", async () => {
  const source = readFileSync(new URL("../src/recordedSpeech/recorded_speech_worker.py", import.meta.url), "utf8");
  // 2026-11-05 live: a request with no reference raised NameError on ref_audio; Fish speaks fine with ref_audio=None.
  expect(source).toContain("if not refs:\n        ref_audio, ref_text = None, None");
});
