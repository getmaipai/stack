import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { Button } from "@/kit/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/kit/ui/card";
import { Input } from "@/kit/ui/input";

export function LoginPage() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.post("/stack/v1/operator/login", { password });
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
          <CardTitle className="text-3xl">Welcome back</CardTitle>
          <CardDescription className="text-base">Sign in to open the board and manage the keys.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-6" onSubmit={submit}>
            <label className="block space-y-2 text-base font-medium" htmlFor="login-password">
              Operator password
              <Input id="login-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
            </label>
            {error && <p className="text-base text-destructive" role="alert">{error}</p>}
            <Button type="submit" disabled={saving}>{saving ? "Signing in..." : "Sign in"}</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
