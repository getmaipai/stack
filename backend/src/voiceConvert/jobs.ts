import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerJobRunner, type Job, type JobProgress } from "@/lib/jobs";
import { getJob as readJob } from "@/lib/jobs";
import { GenTracker, recordRun } from "@/lib/genProgress";
import { voiceConvert, VOICE_CONVERT_PEAK_BYTES } from "./voiceConvert";
import { resultDir, workDir } from "@/music/results";
import { dataDir } from "@/lib/paths";
import { sha256Hex } from "@/music/provenance";

export const VOICE_CONVERT_JOB_KIND = "voice_convert_generation";
const failures = new Map<string, { code: string; message: string }>(); const stages = new Map<string, string>(); const trackers = new Map<string, GenTracker>();
export const voiceConvertFailure = (id: string) => failures.get(id) ?? null; export const voiceConvertStage = (id: string) => stages.get(id) ?? null; export const voiceConvertTracker = (id: string) => trackers.get(id) ?? null;
const remember = <T>(map: Map<string,T>, key: string, value:T) => { map.set(key,value); if(map.size>200) map.delete(map.keys().next().value as string); };
const stash = new Map<string,{source:Uint8Array;reference:Uint8Array;pitch_shift:number;auto_shift:boolean;at:number}>();
export function stashVoiceConvert(token:string, source:Uint8Array, reference:Uint8Array, pitch_shift:number, auto_shift:boolean) { const now=Date.now(); for(const [k,v] of stash) if(now-v.at>30*60_000) stash.delete(k); stash.set(token,{source,reference,pitch_shift,auto_shift,at:now}); }
export function unstashVoiceConvert(token:string) { stash.delete(token); }
export function __voiceConvertStashHasForTests(token:string) { return stash.has(token); }

async function run(job:Job, signal:AbortSignal, update:JobProgress) {
  const input=job.input as {token:string}|null; const payload=stash.get(input?.token??""); stash.delete(input?.token??""); if(!payload) throw new Error("The request was not received. Send it again.");
  const work=workDir(job.id); rmSync(work,{recursive:true,force:true}); mkdirSync(work,{recursive:true,mode:0o700});
  try {
    const source=join(work,"source.audio"), reference=join(work,"reference.audio"), outputWork=join(work,"converted.m4a"), outputWav=join(work,"converted.wav"); writeFileSync(source,payload.source,{mode:0o600}); writeFileSync(reference,payload.reference,{mode:0o600});
    const tracker=new GenTracker("music","voice-convert:soulx-singer-svc"); remember(trackers,job.id,tracker); const started=Date.now();
    const result=await voiceConvert.run({id:job.id,source,reference,output:outputWork,outputWav,workDir:work,pitch_shift:payload.pitch_shift,auto_shift:payload.auto_shift},(stage,fraction)=>{remember(stages,job.id,stage);tracker.enter(stage==="loading"?"load":stage==="saving"?"save":"music");update({status:stage,percent:Math.round(fraction*100)});},signal);
    recordRun(tracker.key,tracker.finish()); const bytes=new Uint8Array(readFileSync(outputWork)); const digest=sha256Hex(bytes); const target=resultDir(job.id); mkdirSync(join(dataDir,"music","results"),{recursive:true,mode:0o700}); rmSync(target,{recursive:true,force:true}); mkdirSync(target,{mode:0o700}); renameSync(outputWork,join(target,"vocal.m4a")); writeFileSync(join(target,"voice-convert.json"),JSON.stringify({job:job.id,created:Math.floor(Date.now()/1000),bytes:bytes.length,sha256:digest}),{mode:0o600});
    const root=join(dataDir,"music","results"), newest=Number(process.env.MUSIC_RESULT_KEEP??6), ttl=Number(process.env.MUSIC_RESULT_TTL_MS??10*60_000); readdirSync(root).filter((id)=>/^job-[0-9a-f-]{36}$/.test(id)).map((id)=>({id,at:statSync(join(root,id)).mtimeMs})).sort((a,b)=>b.at-a.at).forEach((e,i)=>{if(i>=newest||Date.now()-e.at>ttl) rmSync(join(root,e.id),{recursive:true,force:true});});
    update({status:"ready",percent:100}); return {job:job.id,ms:Date.now()-started,worker_ms:result.ms,bytes:bytes.length,sha256:digest,url:`/v1/audio/voice-convert/${job.id}/file`};
  } catch(error) { if(!signal.aborted) remember(failures,job.id,{code:"failed",message:error instanceof Error?error.message:"The vocal could not be converted."}); throw error; } finally { rmSync(work,{recursive:true,force:true}); }
}
export function registerVoiceConvertJobs() { registerJobRunner(VOICE_CONVERT_JOB_KIND,run,{generator:{role:"music",memory:()=>({requestedBytes:VOICE_CONVERT_PEAK_BYTES,measuredPeakBytes:VOICE_CONVERT_PEAK_BYTES,engine:"voice-convert"})}}); }
