import { descendantsOf, listProcessTable, commandLineOf, startTimeOf, type TreeSnapshot } from "@/lib/processTree";

type Member = { pid: number; startTime: string; command: string };
type Entry = { kind: string; root: number; members: Map<number, Member>; finishedAt: number | null };
export interface OwnedHandle { refresh(): void; finished(): void; }
const entries = new Set<Entry>();

export function registerOwned(kind: string, root: TreeSnapshot | number): OwnedHandle {
  const pid = typeof root === "number" ? root : root.rootPid;
  const entry: Entry = { kind, root: pid, members: new Map(), finishedAt: null };
  entries.add(entry);
  const refresh = () => {
    const table = listProcessTable();
    for (const memberPid of [pid, ...descendantsOf(pid, table)]) if (!entry.members.has(memberPid)) {
      const command = commandLineOf(memberPid), startTime = startTimeOf(memberPid);
      if (command && startTime) entry.members.set(memberPid, { pid: memberPid, command, startTime });
    }
  };
  refresh();
  return { refresh, finished: () => { refresh(); entry.finishedAt ??= Date.now(); } };
}

export function ownedPids(): Set<number> {
  const result = new Set<number>();
  const now = Date.now();
  for (const entry of entries) {
    const live = [...entry.members.values()].filter((member) => startTimeOf(member.pid) === member.startTime && commandLineOf(member.pid) === member.command);
    if (entry.finishedAt !== null && (!live.length || now - entry.finishedAt > 10 * 60_000)) { entries.delete(entry); continue; }
    for (const member of live) result.add(member.pid);
  }
  return result;
}

export function finishedSurvivors(now = Date.now()): Array<Member & { kind: string }> {
  const found: Array<Member & { kind: string }> = [];
  for (const entry of entries) {
    if (entry.finishedAt === null) continue;
    const live = [...entry.members.values()].filter((member) => startTimeOf(member.pid) === member.startTime && commandLineOf(member.pid) === member.command);
    if (!live.length || now - entry.finishedAt > 10 * 60_000) { entries.delete(entry); continue; }
    for (const member of live) found.push({ ...member, kind: entry.kind });
  }
  return found;
}
