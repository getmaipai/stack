import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type HardwareResponse, type ProfileTier } from "@/lib/api";
import { useApiResource } from "@/lib/useApiResource";
import { Badge } from "@/kit/ui/badge";
import { Button } from "@/kit/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/kit/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/kit/ui/dialog";
import { Input } from "@/kit/ui/input";
import { Progress } from "@/kit/ui/progress";
import { Skeleton } from "@/kit/ui/skeleton";

type SetupStep = 1 | 2 | 3 | 4;

const RAIL = ["Welcome", "Your login", "This computer", "Downloading", "Ready"];

function formatDisk(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "Unknown";
  return Math.round(bytes / 1_073_741_824) + " GB";
}

function Rail({ step }: { step: SetupStep }) {
  return (
    <nav aria-label="First run progress" className="flex gap-3 overflow-x-auto pb-2 lg:block lg:w-52 lg:shrink-0 lg:space-y-3 lg:pb-0">
      {RAIL.map((label, index) => {
        const number = index + 1;
        const current = number === (step === 4 ? 5 : step);
        const completed = number < (step === 4 ? 5 : step);
        return (
          <div
            className={"flex min-w-32 items-center gap-3 rounded-lg p-3 text-base " + (current ? "bg-secondary font-medium" : "text-muted-foreground")}
            key={label}
            aria-current={current ? "step" : undefined}
          >
            <span className={"flex size-8 shrink-0 items-center justify-center rounded-full text-sm " + (completed || current ? "bg-primary text-primary-foreground" : "bg-muted")}>
              {number}
            </span>
            <span>{label}{label === "Downloading" ? " (later)" : ""}</span>
          </div>
        );
      })}
    </nav>
  );
}

function Welcome({ onContinue }: { onContinue: () => void }) {
  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <Badge variant="secondary">Step 1 of 5</Badge>
        <CardTitle className="text-3xl">Welcome to MaiPai Stack</CardTitle>
        <CardDescription className="text-base">MaiPai Stack runs AI on this computer. Nothing leaves it.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <p className="text-base leading-7 text-muted-foreground">
          The AI can be wrong, and it is never medical, legal, or professional advice.
        </p>
        <Button onClick={onContinue}>Continue</Button>
      </CardContent>
    </Card>
  );
}

function LoginStep({ onBack, onComplete }: { onBack: () => void; onComplete: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.post("/stack/v1/operator/setup", { password });
      onComplete();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Your login could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <Badge variant="secondary">Step 2 of 5</Badge>
        <CardTitle className="text-3xl">Your login</CardTitle>
        <CardDescription className="text-base">This secures the pages and the keys. No email, no account anywhere else.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-6" onSubmit={submit}>
          <label className="block space-y-2 text-base font-medium" htmlFor="operator-password">
            Operator password
            <Input
              id="operator-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {error && <p className="text-base text-destructive" role="alert">{error}</p>}
          <div className="flex flex-wrap gap-3">
            <Button type="button" variant="outline" onClick={onBack}>Back</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Continue"}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function ProfileDialog({ tiers, selected, onSelect }: { tiers: ProfileTier[]; selected: ProfileTier | null; onSelect: (tier: ProfileTier) => void }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="link" className="h-auto p-0">Change</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Choose a profile</DialogTitle>
          <DialogDescription>Each profile describes what this computer can do. The choice uses measured hardware facts.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {tiers.map((tier) => (
            <Button
              className="h-auto justify-start whitespace-normal p-4 text-left"
              key={tier.id}
              variant={selected?.id === tier.id ? "secondary" : "outline"}
              onClick={() => onSelect(tier)}
            >
              <span>
                <span className="block font-medium">{tier.id.toUpperCase()}</span>
                <span className="block text-base font-normal">{tier.label}</span>
              </span>
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ComputerStep({ onBack, onContinue }: { onBack: () => void; onContinue: () => void }) {
  const resource = useApiResource<HardwareResponse>("/stack/v1/hardware");
  const [selected, setSelected] = useState<ProfileTier | null>(null);
  const profile = selected ?? resource.data?.proposed ?? null;

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <Badge variant="secondary">Step 3 of 5</Badge>
        <CardTitle className="text-3xl">This computer</CardTitle>
        <CardDescription className="text-base">Here is what the Stack measured on this computer.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {resource.loading && <Skeleton className="h-28 w-full" />}
        {resource.error && <p className="text-base text-destructive" role="alert">{resource.error.message}</p>}
        {resource.data && (
          <>
            <div className="grid gap-3 rounded-xl bg-muted p-4 sm:grid-cols-2">
              <div><p className="text-muted-foreground">Chip and operating system</p><p className="font-medium">{resource.data.hardware.platform} {resource.data.hardware.arch}, {resource.data.hardware.osVersion}</p></div>
              <div><p className="text-muted-foreground">Memory and free space</p><p className="font-medium">{resource.data.hardware.totalRamGb} GB RAM, {formatDisk(resource.data.hardware.freeDiskBytes)} free</p></div>
            </div>
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">Proposed profile</p>
                <ProfileDialog tiers={resource.data.tiers} selected={profile} onSelect={setSelected} />
              </div>
              <p className="text-base leading-7 text-muted-foreground">{profile?.label ?? "This computer does not meet a profile yet."}</p>
            </div>
          </>
        )}
        <div className="flex flex-wrap gap-3">
          <Button type="button" variant="outline" onClick={onBack}>Back</Button>
          <Button type="button" onClick={onContinue} disabled={!resource.data || resource.loading}>Continue</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ReadyStep({ onBack, onBoard }: { onBack: () => void; onBoard: () => void }) {
  return (
    <div className="grid max-w-4xl gap-4 md:grid-cols-2">
      <Card className="md:col-span-2">
        <CardHeader>
          <Badge variant="secondary">Step 5 of 5</Badge>
          <CardTitle className="text-3xl">Ready</CardTitle>
          <CardDescription className="text-base">Your local AI Stack is ready to look after this computer.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={onBoard}>Open the board</Button>
          <div className="rounded-xl bg-muted p-4 text-base text-muted-foreground">Downloads arrive in a later step.</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Try it</CardTitle>
          <CardDescription>Exercise each role from the Stack. This arrives in the next step.</CardDescription>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Share with your family.</CardTitle>
          <CardDescription>The Stack is yours alone. MaiPai Home adds people, kid-safe profiles, memory, and companions on top of it, on this same computer.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline"><a href="/home">Install MaiPai Home</a></Button>
        </CardContent>
      </Card>
      <div className="flex gap-3 md:col-span-2">
        <Button variant="outline" onClick={onBack}>Back</Button>
      </div>
    </div>
  );
}

export function SetupPage({ initialStep = 1 }: { initialStep?: SetupStep }) {
  const [step, setStep] = useState<SetupStep>(initialStep);
  const navigate = useNavigate();
  return (
    <main className="min-h-screen bg-background px-4 py-6 text-foreground sm:px-8 lg:px-12 lg:py-12">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 lg:flex-row">
        <div className="space-y-2 lg:w-52 lg:shrink-0">
          <p className="text-lg font-semibold">MaiPai Stack</p>
          <p className="text-base text-muted-foreground">First run</p>
        </div>
        <Rail step={step} />
        <section className="min-w-0 flex-1">
          <Progress className="mb-6 h-2 max-w-3xl" value={step === 4 ? 100 : step * 20} aria-label="First run progress" />
          {step === 1 && <Welcome onContinue={() => setStep(2)} />}
          {step === 2 && <LoginStep onBack={() => setStep(1)} onComplete={() => setStep(3)} />}
          {step === 3 && <ComputerStep onBack={() => setStep(2)} onContinue={() => setStep(4)} />}
          {step === 4 && <ReadyStep onBack={() => setStep(3)} onBoard={() => navigate("/")} />}
        </section>
      </div>
    </main>
  );
}
