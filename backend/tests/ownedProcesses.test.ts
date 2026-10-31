import { describe, expect, test, beforeEach } from "bun:test";
import { __setProcessTreeReadersForTests, type ProcessRow, TreeSnapshot } from "@/lib/processTree";
import { finishedSurvivors, ownedPids, registerOwned } from "@/lib/ownedProcesses";

describe("owned process registry", () => {
  let rows: ProcessRow[];
  let starts: Map<number, string>;
  let commands: Map<number, string>;
  beforeEach(() => {
    rows = [{ pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 20, ppid: 1 }];
    starts = new Map([[10, "a"], [11, "b"], [20, "c"]]);
    commands = new Map([[10, "root"], [11, "child"], [20, "bare"]]);
    __setProcessTreeReadersForTests({ processTable: () => rows, startTime: (pid) => starts.get(pid) ?? "", commandLine: (pid) => commands.get(pid) ?? "" });
  });
  test("keeps registered tree and bare pid identities until gone or expired", () => {
    const tree = registerOwned("test-tree", new TreeSnapshot(10));
    const bare = registerOwned("test-bare", 20);
    expect(ownedPids()).toEqual(new Set([10, 11, 20]));
    tree.finished(); bare.finished();
    starts.set(11, "reused");
    expect(finishedSurvivors(Date.now()).map((member) => member.pid)).toEqual([10, 20]);
    rows = [{ pid: 10, ppid: 1 }]; starts.delete(20);
    expect(finishedSurvivors(Date.now()).map((member) => member.pid)).toEqual([10]);
    expect(finishedSurvivors(Date.now() + 10 * 60_000 + 1)).toEqual([]);
  });
});
