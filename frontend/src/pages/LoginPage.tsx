import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type OperatorState } from "@/lib/api";
import { Button } from "@/kit/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/kit/ui/card";
import { Input } from "@/kit/ui/input";

export function LoginPage({ state, onSignedIn }: { state: OperatorState; onSignedIn?: (state: OperatorState) => void }) {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const result = await api.post<OperatorState>(state.state === "setupRequired" ? "/stack/v1/operator/setup" : "/stack/v1/operator/login", { password });
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
      <Card className="mx-auto w-full max-w-md">
        <CardHeader>
          <p className="text-lg font-semibold">MaiPai Stack</p>
          <CardTitle className="text-3xl">{state.state === "setupRequired" ? "Set the operator password" : "Welcome back"}</CardTitle>
          <CardDescription className="text-base">{state.state === "setupRequired" ? "MaiPai Stack runs AI on this computer. Nothing leaves it." : "Sign in to manage this Stack from another device."}</CardDescription>
        </CardHeader>
        <CardContent>
          {state.state === "setupRequired" && !state.loopback ? <p className="text-base text-muted-foreground">Set the operator password on the computer that runs the Stack first.</p> : <form className="space-y-6" onSubmit={submit}>
            <label className="block space-y-2 text-base font-medium" htmlFor="login-password">
              Operator password
              <Input id="login-password" type="password" autoComplete={state.state === "setupRequired" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} required />
            </label>
            {error && <p className="text-base text-destructive" role="alert">{error}</p>}
            <Button type="submit" disabled={saving}>{saving ? (state.state === "setupRequired" ? "Setting password..." : "Signing in...") : (state.state === "setupRequired" ? "Set password" : "Sign in")}</Button>
          </form>}
        </CardContent>
      </Card>
    </main>
  );
}
