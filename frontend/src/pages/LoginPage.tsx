import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type OperatorState } from "@/lib/api";
import { isDesktop } from "@/kit/host";
import { Button } from "@/kit/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/kit/ui/card";
import { Input } from "@/kit/ui/input";

// Set by MachineSelector's Lock MaiPai before it reloads the app, so this
// page can tell "the operator locked it" apart from any other reason the
// session ended (spec: the login card reads "Locked" with its own
// sentence only "when the state came from a lock").
const LOCKED_KEY = "maipai-stack:locked";

export function LoginPage({ state, onSignedIn }: { state: OperatorState; onSignedIn?: (state: OperatorState) => void }) {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [locked] = useState(() => state.state === "signedOut" && sessionStorage.getItem(LOCKED_KEY) === "1");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const result = await api.post<OperatorState>(state.state === "setupRequired" ? "/stack/v1/operator/setup" : "/stack/v1/operator/login", { password });
      sessionStorage.removeItem(LOCKED_KEY);
      onSignedIn?.(result);
      navigate("/", { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The password was not accepted.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center bg-background px-4 py-8 text-foreground sm:px-8">
      <Card className="mx-auto w-full max-w-md gap-4">
        <CardHeader className="justify-items-center px-6 text-center">
          <picture>
            <source media="(prefers-color-scheme: dark)" srcSet="/brand/maipai-stack-icon-dark.png" />
            <img className="size-12" src="/brand/maipai-stack-icon-light.png" alt="MaiPai Stack" />
          </picture>
          <CardTitle className="text-3xl">{state.state === "setupRequired" ? "Set the operator password" : locked ? "Locked" : "Welcome back"}</CardTitle>
          {locked && <p className="text-base text-muted-foreground">Enter the operator password to unlock. The Stack keeps running.</p>}
        </CardHeader>
        <CardContent className="space-y-6 text-center">
          {state.state === "setupRequired" && !state.loopback && !isDesktop() ? <p className="text-base text-muted-foreground">Set the operator password on the computer that runs the Stack first.</p> : <form className="space-y-6" onSubmit={submit}>
            <label className="block space-y-2 text-base font-medium" htmlFor="login-password">
              Operator password
              <Input id="login-password" type="password" autoComplete={state.state === "setupRequired" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} required />
            </label>
            {error && <p className="text-base text-destructive" role="alert">{error}</p>}
            <Button className="w-full" type="submit" disabled={saving}>{saving ? (state.state === "setupRequired" ? "Setting password..." : "Signing in...") : (state.state === "setupRequired" ? "Set password" : "Sign in")}</Button>
          </form>}
          <p className="text-sm text-muted-foreground">MaiPai Stack runs AI on this computer. Nothing leaves it. The AI can be wrong, and it is never medical, legal, or professional advice.</p>
        </CardContent>
      </Card>
    </main>
  );
}
