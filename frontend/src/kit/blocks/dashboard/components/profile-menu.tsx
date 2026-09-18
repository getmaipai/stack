// Reskinned for MaiPai Stack: the profile menu in the header.
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type OperatorState } from "@/lib/api";
import { useApiResource } from "@/lib/useApiResource";
import { ClientKeyDialog } from "@/pages/ClientKeyDialog";
import { ThemeToggle } from "@/kit/blocks/dashboard/components/theme-toggle";
import { getIcon } from "@/kit/icons";
import { Button } from "@/kit/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/kit/ui/dropdown-menu";

const ExternalLink = getIcon("ExternalLink");
const KeyRound = getIcon("KeyRound");
const LogOut = getIcon("LogOut");
const Lock = getIcon("Lock");

export function ProfileMenu({ onSignedIn, onSignedOut }: { onSignedIn?: () => void; onSignedOut?: () => void }) {
  const operator = useApiResource<OperatorState>("/stack/v1/operator");
  const navigate = useNavigate();
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  useEffect(() => { if (!operator.loading && operator.data?.state === "signedIn") onSignedIn?.(); }, [operator.loading, operator.data?.state, onSignedIn]);
  async function signOut() { await api.post("/stack/v1/operator/logout"); onSignedOut?.(); navigate("/login"); }
  const state = operator.data?.state ?? "signedOut";
  const hasPassword = state !== "setupRequired";
  return <><DropdownMenu>
    <DropdownMenuTrigger asChild data-profile-trigger><Button variant="outline" className="size-8 rounded-full p-0" aria-label="Operator profile"><span className="text-xs font-semibold">O</span></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-56">
      <DropdownMenuLabel>Operator</DropdownMenuLabel>
      <DropdownMenuLabel className="font-normal text-muted-foreground">{hasPassword ? "Signed in" : "Password not set"}</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={(event) => event.preventDefault()}><ThemeToggle always /><span>Theme</span></DropdownMenuItem>
      {!hasPassword && <DropdownMenuItem onSelect={() => setPasswordDialogOpen(true)}><Lock />Set a password</DropdownMenuItem>}
      {state === "signedIn" && <DropdownMenuItem onSelect={() => void signOut()}><LogOut />Sign out</DropdownMenuItem>}
      <DropdownMenuItem asChild><Link to="/access"><KeyRound />Clients</Link></DropdownMenuItem>
      <DropdownMenuItem asChild><a href="/api/docs" target="_blank" rel="noreferrer"><ExternalLink />API docs</a></DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu><ClientKeyDialog open={passwordDialogOpen} onOpenChange={setPasswordDialogOpen} onCreated={() => void operator.refetch()} /></>;
}
