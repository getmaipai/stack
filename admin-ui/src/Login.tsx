import { useState } from "react";
import { Button } from "@maipai/ui/src/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@maipai/ui/src/ui/card";
import { Input } from "@maipai/ui/src/ui/input";
import { Label } from "@maipai/ui/src/ui/label";
import { Alert, AlertDescription } from "@maipai/ui/src/ui/alert";
import { ApiError, api } from "./api";

/** Sign-in, or first-run setup when the Stack has no admin yet (the Stack answers 409 `no_admin`). */
export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [setup, setSetup] = useState(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (setup && password !== confirm) { setError("The two passwords are different. Type the same password in both boxes."); return; }
    setBusy(true);
    try {
      if (setup) await api.setup(code.trim(), password);
      await api.login(password);
      onSignedIn();
    } catch (e) {
      if (e instanceof ApiError && e.code === "no_admin") {
        setSetup(true);
        setError("This Stack has no admin yet. Enter the setup code from the Stack's log (or its setup-code file) and choose a password.");
      } else if (e instanceof ApiError && e.code === "admin_exists") {
        setSetup(false);
        setError("An admin already exists. Sign in with its password.");
      } else if (e instanceof ApiError && e.retryAfter !== undefined) {
        setError(`${e.message} Try again in ${e.retryAfter} seconds.`);
      } else {
        setError(e instanceof ApiError ? e.message : "The Stack did not answer. Check that it is running, then try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-8">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{setup ? "Set up the Stack admin" : "MaiPai Stack"}</CardTitle>
          <CardDescription>
            {setup ? "Choose the one admin password for this Stack." : "Sign in to manage the engines on this computer."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => { void submit(e); }} className="flex flex-col gap-4" aria-label={setup ? "First-run setup" : "Sign in"}>
            {setup && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="code">Setup code</Label>
                <Input id="code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} required />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">{setup ? "New password" : "Admin password"}</Label>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={setup ? "new-password" : "current-password"} required autoFocus />
            </div>
            {setup && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="confirm">Type it again</Label>
                <Input id="confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
              </div>
            )}
            {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
            <Button type="submit" disabled={busy}>{busy ? "One moment" : setup ? "Set password and sign in" : "Sign in"}</Button>
            <Button type="button" variant="link" size="sm" onClick={() => { setSetup(!setup); setError(null); }}>
              {setup ? "I already have a password" : "First time here? Set up the admin"}
            </Button>
            {!setup && <p className="text-sm text-muted-foreground">Forgot the password? Reset it with a command on the computer the Stack runs on.</p>}
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
