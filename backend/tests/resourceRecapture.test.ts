import { expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import { isAlive, processTree } from "@/lib/processTree";
import { getGovernorStatus } from "@/lib/governor";
import { memoryWatchdog } from "@/lib/memoryWatchdog";
import { jobHarness, type Outcome } from "./helpers/jobHarness";

const tmpBytes=(dir:string):number=>{try{return readdirSync(dir,{withFileTypes:true}).reduce((sum,e)=>{const p=join(dir,e.name);try{return sum+(e.isDirectory()?tmpBytes(p):e.isFile()?statSync(p).size:0);}catch{return sum;}},0);}catch{return 0;}};
// The ps the reader spawns lists itself and is gone a moment later; only live pids count.
const tree=()=>processTree(process.pid).slice(1).filter(isAlive).sort((a,b)=>a-b);
// The test process itself holds memory no ledger item accounts for, so the bound is a delta from the baseline.
const UNACCOUNTED_SLACK=64*1024**2;

async function runAndMeasure(kind:"picture"|"video"|"music",outcome:Outcome):Promise<void>{
  if(kind==="picture")process.env.IMAGE_IDLE_MS="1000";
  if(kind==="video")process.env.VIDEO_IDLE_MS="1000";
  if(kind==="music")process.env.MUSIC_IDLE_MS="1000";
  const baseline={processes:tree(),loaded:getGovernorStatus().loaded.map(x=>x.id).sort(),tmp:tmpBytes(join(dataDir,"tmp")),unaccounted:memoryWatchdog().report().stack.unaccounted_bytes};
  const harness=jobHarness[kind]();
  try{
    const {job}=await harness.start(outcome);
    if(outcome==="cancelled"){await harness.cancel(job);expect(await harness.waitEnd(job)).toBe("cancelled");}
    else expect(await harness.waitEnd(job)).toBe(outcome);
    harness.stop();
    const until=Date.now()+8000;let current=baseline;
    while(Date.now()<until){
      current={processes:tree(),loaded:getGovernorStatus().loaded.map(x=>x.id).sort(),tmp:tmpBytes(join(dataDir,"tmp")),unaccounted:memoryWatchdog().report().stack.unaccounted_bytes};
      if(current.processes.join()===baseline.processes.join()&&current.loaded.join()===baseline.loaded.join()&&current.tmp<=baseline.tmp&&current.unaccounted<=baseline.unaccounted+UNACCOUNTED_SLACK)break;
      await Bun.sleep(100);
    }
    expect(current.processes).toEqual(baseline.processes);
    expect(current.loaded).toEqual(baseline.loaded);
    expect(current.tmp).toBeLessThanOrEqual(baseline.tmp);
    expect(current.unaccounted).toBeLessThanOrEqual(baseline.unaccounted+UNACCOUNTED_SLACK);
  }finally{harness.stop();delete process.env.IMAGE_IDLE_MS;delete process.env.VIDEO_IDLE_MS;delete process.env.MUSIC_IDLE_MS;}
}

for(const kind of ["picture","video","music"] as const)for(const outcome of ["done","failed","cancelled"] as const)test(`${kind} ${outcome} recaptures resources`,()=>runAndMeasure(kind,outcome),20_000);
