import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/app";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, forgetLoadedItem } from "@/lib/governor";
import { __resetJobsForTests, getJob } from "@/lib/jobs";
import { dataDir } from "@/lib/paths";
import { imageGen, workerHandle as imageWorkerHandle, type ImageGenDeps, type WorkerRequest as ImageRequest, type WorkerReply as ImageReply } from "@/images/imageEngine";
import { __setInstalledFamiliesForTests } from "@/images/models";
import { registerImageJobs } from "@/images/jobs";
import { videoGen, workerHandle as videoWorkerHandle, type VideoGenDeps, type WorkerRequest as VideoRequest, type WorkerReply as VideoReply } from "@/video/videoGen";
import { registerVideoJobs } from "@/video/jobs";
import { musicGen, workerHandle as musicWorkerHandle, type MusicGenDeps, type WorkerRequest as MusicRequest, type WorkerReply as MusicReply } from "@/music/musicGen";
import { registerMusicJobs } from "@/music/jobs";
import { removeWorkerDir, startLeakyWorker, waitForWorkerPids, waitForWorkerRequest } from "./leakyWorker";

export type Outcome = "done" | "failed" | "cancelled";
type Harness = { start(outcome: Outcome): Promise<{ job: string }>; cancel(job: string): Promise<void>; waitEnd(job: string): Promise<string>; stop(): void };
const error = (id: string) => ({ id, ok: false as const, code: "failed", error: "Scripted failure." });

function initialize(cleaner: () => void): void {
  cleaner(); __resetJobsForTests(); __resetGovernorForTests();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * 1024 ** 3, freeMemoryBytes: 64 * 1024 ** 3, tier: "p128" });
}

async function poll(path: string, job: string): Promise<string> {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const current=getJob(job);
    if(current&&["done","failed","cancelled"].includes(current.state))return current.state;
    await Bun.sleep(20);
  }
  throw new Error(`Job ${job} did not finish`);
}

function picture(): Harness {
  let dir: string | undefined; let pids: number[] = [];
  const clean = () => { imageGen.useDeps(null); __resetJobsForTests(); __resetGovernorForTests(); __setInstalledFamiliesForTests(null); for (const p of ["images", "tmp/images"]) rmSync(join(dataDir,p),{recursive:true,force:true}); };
  initialize(clean); __setInstalledFamiliesForTests(["flux2-klein-4b"]); registerImageJobs();
  const ordinary: ImageGenDeps = { supported:()=>true, ensureEnvironment:async()=>{}, snapshot:(f)=>`/models/${f}`, spawn: async()=>({exited:new Promise<number>(()=>{}),kill:()=>{},cancel:()=>{},send:async(r:ImageRequest)=> error(r.id) as ImageReply}) };
  imageGen.useDeps(ordinary);
  return {
    start: async (outcome) => {
      
      imageGen.useDeps({ ...ordinary, spawn: async()=> { if(outcome==="cancelled"){const started=startLeakyWorker(imageWorkerHandle);dir=started.dir;pids=await waitForWorkerPids(started.pidFile);return started.worker;} return {exited:new Promise<number>(()=>{}),kill:()=>{},cancel:()=>{},send:async(r:ImageRequest)=>{if(outcome==="failed")return error(r.id) as ImageReply;mkdirSync(r.out_dir,{recursive:true});writeFileSync(join(r.out_dir,"0.png"),Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,1,0,0,0,1,0]));writeFileSync(join(r.out_dir,"0.thumb.jpg"),"JPG");return {id:r.id,ok:true,seeds:[r.seed],ms:1,peak_bytes:10,width:r.width,height:r.height} as ImageReply;}} as any; }});
      const response=await app.request("/v1/images/generations",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({prompt:"test",size:"256x256",n:1,timeout_ms:100})});
      const data=await response.json() as {job?:string}; if(!data.job) throw new Error(`Picture submission returned ${response.status}`);
      if(outcome==="cancelled") await waitForWorkerRequest(join(dir!,"accepted"));
      return {job:data.job};
    },
    cancel: async(job)=>{await app.request(`/v1/images/generations/${job}`,{method:"DELETE"});},
    waitEnd: async(job)=>poll("/v1/images/generations",job),
    stop:()=>{imageGen.stop();forgetLoadedItem("image-pool"); if(dir){removeWorkerDir(dir);dir=undefined;}}
  };
}

function video(): Harness {
  let dir: string | undefined;
  const clean=()=>{videoGen.useDeps(null);__resetJobsForTests();__resetGovernorForTests();__setGovernorTuningForTestsOnly({ totalMemoryBytes:128*1024**3, freeMemoryBytes:64*1024**3, tier:"p128" });for(const p of ["video","tmp/video"])rmSync(join(dataDir,p),{recursive:true,force:true});};
  initialize(clean);registerVideoJobs();
  const deps: VideoGenDeps={supported:()=>true,ensureEnvironment:async()=>{},paths:()=>({modelDir:"/models/video",tokenizerDir:"/models/tok"}),spawn:async()=>({exited:new Promise<number>(()=>{}),kill:()=>{},send:async(r:VideoRequest)=>error(r.id) as VideoReply})}; videoGen.useDeps(deps);
  return { start:async(outcome)=>{videoGen.useDeps({...deps,spawn:async()=>{if(outcome==="cancelled"){const x=startLeakyWorker(videoWorkerHandle);dir=x.dir;return x.worker;}return {exited:new Promise<number>(()=>{}),kill:()=>{},send:async(r:VideoRequest)=>{if(outcome==="failed")return error(r.id) as VideoReply;mkdirSync(join(r.output,".."),{recursive:true});writeFileSync(r.output,"MP4DATA-0123456789");writeFileSync(r.poster,"JPEGDATA");return {id:r.id,ok:true,width:r.width,height:r.height,frames:r.num_frames,fps:24,seed:r.seed,ms:1,peak_bytes:10} as VideoReply;}} as any;}});const r=await app.request("/v1/videos/generations",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({prompt:"test",size:"256x256",seconds:1,timeout_ms:100})});const b=await r.json() as {job?:string};if(!b.job)throw new Error(`Video submission returned ${r.status}`);if(outcome==="cancelled")await waitForWorkerRequest(join(dir!,"accepted"));return {job:b.job};}, cancel:async(j)=>{await app.request(`/v1/videos/generations/${j}`,{method:"DELETE"});},waitEnd:(j)=>poll("/v1/videos/generations",j),stop:()=>{videoGen.stop();forgetLoadedItem("video-worker");if(dir){removeWorkerDir(dir);dir=undefined;}}};
}

function music(): Harness {
  let dir:string|undefined;
  const clean=()=>{musicGen.useDeps(null);__resetJobsForTests();__resetGovernorForTests();__setGovernorTuningForTestsOnly({ totalMemoryBytes:128*1024**3, freeMemoryBytes:64*1024**3, tier:"p128" });for(const p of ["music","tmp/music"])rmSync(join(dataDir,p),{recursive:true,force:true});};initialize(clean);registerMusicJobs();
  const deps:MusicGenDeps={supported:()=>true,ensureEnvironment:async()=>{},installed:()=>true,runtime:()=>({ckptDir:"/models/music",ffmpeg:"/bin/ffmpeg"}),spawn:async()=>({exited:new Promise<number>(()=>{}),kill:()=>{},send:async(r:MusicRequest)=>error(r.id) as MusicReply})};musicGen.useDeps(deps);
  return {start:async(outcome)=>{musicGen.useDeps({...deps,spawn:async()=>{if(outcome==="cancelled"){const x=startLeakyWorker(musicWorkerHandle);dir=x.dir;return x.worker;}return {exited:new Promise<number>(()=>{}),kill:()=>{},send:async(r:MusicRequest)=>{if(outcome==="failed")return error(r.id) as MusicReply;mkdirSync(join(r.output,".."),{recursive:true});writeFileSync(r.output,"\0\0\0 ftypM4A \0\0\0\0M4A mp42isom fake-audio-test");return {id:r.id,ok:true,duration_s:r.duration_s??10,seed:r.seed??5,task:r.task,ms:1,peak_bytes:10} as MusicReply;}} as any;}});const r=await app.request("/v1/audio/music",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({task:"text2music",caption:"test",instrumental:true,duration_s:10,timeout_ms:100})});const b=await r.json() as {job?:string};if(!b.job)throw new Error(`Music submission returned ${r.status}`);if(outcome==="cancelled")await waitForWorkerRequest(join(dir!,"accepted"));return {job:b.job};},cancel:async(j)=>{await app.request(`/v1/audio/music/${j}`,{method:"DELETE"});},waitEnd:(j)=>poll("/v1/audio/music",j),stop:()=>{musicGen.stop();forgetLoadedItem("music-worker");if(dir){removeWorkerDir(dir);dir=undefined;}}};
}

export const jobHarness: Record<"picture"|"video"|"music",()=>Harness>={picture,video,music};

/** Puts every global the harness touched back as the next test file expects it: engine deps, installed picture
 * families, the job and governor state. The last harness of a file would otherwise leave the families override set. */
export function resetJobHarness(): void {
  imageGen.useDeps(null); videoGen.useDeps(null); musicGen.useDeps(null);
  __setInstalledFamiliesForTests(null);
  __resetJobsForTests(); __resetGovernorForTests();
}
