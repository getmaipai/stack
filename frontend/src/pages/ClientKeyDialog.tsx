import { type FormEvent, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/kit/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/kit/ui/dialog";
import { Input } from "@/kit/ui/input";

export function ClientKeyDialog({
  open,
  onOpenChange,
  onCreated,
  requiresPassword = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (key: string) => void;
  requiresPassword?: boolean;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [purpose, setPurpose] = useState<"coding" | "chat">("coding");
  const [key, setKey] = useState<string | null>(null);
  const baseUrl =
    typeof window === "undefined"
      ? "http://127.0.0.1:4010/v1"
      : `${window.location.origin}/v1`;
  const config = `OPENAI_BASE_URL=${baseUrl}\nOPENAI_API_KEY=${key ?? ""}`;
  const toolConfigs = [
    [
      "OpenCode",
      `export OPENAI_BASE_URL=${baseUrl}\nexport OPENAI_API_KEY=${key ?? ""}`,
    ],
    [
      "Aider",
      `aider --openai-api-base ${baseUrl} --openai-api-key ${key ?? ""} --model coding`,
    ],
    [
      "Continue",
      JSON.stringify(
        {
          models: [
            {
              title: "MaiPai Stack",
              provider: "openai",
              model: "coding",
              apiBase: baseUrl,
              apiKey: key ?? "",
            },
          ],
        },
        null,
        2,
      ),
    ],
  ] as const;
  useEffect(() => {
    if (!open) {
      setError(null);
      setKey(null);
    }
  }, [open]);
  async function copy(value: string) {
    await navigator.clipboard?.writeText(value);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (requiresPassword)
        await api.post("/stack/v1/operator/setup", { password });
      const result = await api.post<{ key: string }>("/stack/v1/clients", {
        name: purpose === "coding" ? "Coding tool" : "Stack local tool",
        allowedRoles:
          purpose === "coding" ? ["chat", "coding", "embed"] : ["chat"],
      });
      onCreated(result.key);
      setKey(result.key);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The password could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {key
              ? "Connect a coding tool"
              : requiresPassword
                ? "Set your operator password"
                : "Create a key"}
          </DialogTitle>
          <DialogDescription>
            {key
              ? "This key is shown once. Copy a block for the coding tool you use."
              : requiresPassword
                ? "The password was deferred until the first key. It secures the board and future keys on this computer."
                : "Choose what the program can use on this computer."}
          </DialogDescription>
        </DialogHeader>
        {key ? (
          <div className="space-y-5">
            <section className="space-y-2">
              <p className="text-sm font-medium">Stack address</p>
              <code className="block break-all rounded-lg bg-muted p-3 text-sm">
                {baseUrl}
              </code>
            </section>
            <section className="space-y-2">
              <p className="text-sm font-medium">Key</p>
              <code className="block break-all rounded-lg bg-muted p-3 text-sm">
                {key}
              </code>
            </section>
            <ConfigBlock
              title="OpenAI-compatible settings"
              value={config}
              onCopy={copy}
            />
            {toolConfigs.map(([title, value]) => (
              <ConfigBlock
                key={title}
                title={title}
                value={value}
                onCopy={copy}
              />
            ))}
            <p className="text-sm text-muted-foreground">
              Claude Code and Codex CLI need a different wire, coming.
            </p>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => onOpenChange(false)}
            >
              Done
            </Button>
          </div>
        ) : (
          <form className="space-y-5" onSubmit={submit}>
            {requiresPassword && (
              <label
                className="block space-y-2 text-base font-medium"
                htmlFor="deferred-password"
              >
                Operator password
                <Input
                  id="deferred-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </label>
            )}
            <fieldset className="space-y-2">
              <legend className="text-base font-medium">
                What is this key for?
              </legend>
              <div className="flex items-start gap-3 rounded-lg border p-3">
                <input
                  id="key-purpose-coding"
                  aria-label="A coding tool"
                  type="radio"
                  name="key-purpose"
                  checked={purpose === "coding"}
                  onChange={() => setPurpose("coding")}
                />
                <span>
                  <span className="block font-medium">A coding tool</span>
                  <span className="text-sm text-muted-foreground">
                    Chat, Coding, and Embeddings.
                  </span>
                </span>
              </div>
              <div className="flex items-start gap-3 rounded-lg border p-3">
                <input
                  id="key-purpose-chat"
                  aria-label="Chat"
                  type="radio"
                  name="key-purpose"
                  checked={purpose === "chat"}
                  onChange={() => setPurpose("chat")}
                />
                <span>
                  <span className="block font-medium">Chat</span>
                  <span className="text-sm text-muted-foreground">
                    Chat only.
                  </span>
                </span>
              </div>
            </fieldset>
            {error && (
              <p className="text-base text-destructive" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" disabled={saving}>
              {saving
                ? "Saving..."
                : requiresPassword
                  ? "Set password and create key"
                  : "Create key"}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConfigBlock({
  title,
  value,
  onCopy,
}: {
  title: string;
  value: string;
  onCopy: (value: string) => Promise<void>;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">{title}</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void onCopy(value)}
        >
          Copy
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs leading-5">
        <code>{value}</code>
      </pre>
    </section>
  );
}
