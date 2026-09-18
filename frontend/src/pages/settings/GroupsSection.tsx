import { useState } from "react";
import { api } from "@/lib/api";
import { useApiResource } from "@/lib/useApiResource";
import { Button } from "@/kit/ui/button";
import { Input } from "@/kit/ui/input";
import { Badge } from "@/kit/ui/badge";

type Group = { id: string; name: string; parentId: string | null; modelCount: number; memoryBytes: number };

export function GroupsSection() {
  const groups = useApiResource<{ groups: Group[] }>("/stack/v1/groups"); const [name, setName] = useState(""); const [saving, setSaving] = useState(false); const rows = groups.data?.groups ?? [];
  async function create(): Promise<void> { if (!name.trim()) return; setSaving(true); try { await api.post("/stack/v1/groups", { name: name.trim(), parentId: null }); setName(""); await groups.refetch(); } finally { setSaving(false); } }
  async function update(group: Group, input: { name?: string; parentId?: string | null }): Promise<void> { await fetch(`/stack/v1/groups/${group.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }); await groups.refetch(); }
  async function remove(group: Group): Promise<void> { await api.delete(`/stack/v1/groups/${group.id}`); await groups.refetch(); }
  return <div className="space-y-4"><div className="flex gap-2"><Input aria-label="New group name" placeholder="New group name" value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void create(); }} /><Button onClick={() => void create()} disabled={saving || !name.trim()}>Create</Button></div>{rows.map((group) => <div className="flex flex-wrap items-center gap-3 rounded-xl border p-3" key={group.id}><Input aria-label={`Rename ${group.name}`} className="min-w-40 flex-1" defaultValue={group.name} onBlur={(event) => { if (event.target.value.trim() && event.target.value !== group.name) void update(group, { name: event.target.value.trim() }); }} /><select aria-label={`Parent for ${group.name}`} className="h-9 rounded-md border bg-background px-3 text-sm" value={group.parentId ?? ""} onChange={(event) => void update(group, { parentId: event.target.value || null })}><option value="">Top level</option>{rows.filter((candidate) => candidate.id !== group.id).map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.name}</option>)}</select><Badge variant="outline">{group.modelCount} models</Badge><span className="text-sm text-muted-foreground">{Math.round(group.memoryBytes / 1_000_000)} MB</span><Button variant="ghost" onClick={() => void remove(group)}>Delete</Button></div>)}{rows.length === 0 && <p className="text-sm text-muted-foreground">No groups yet. Create one for a household, child, or experiment.</p>}</div>;
}
