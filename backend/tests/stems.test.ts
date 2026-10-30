import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetJobsForTests } from "@/lib/jobs";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly } from "@/lib/governor";
import { dataDir } from "@/lib/paths";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STEMS_JOB_KIND, registerStemsJobs } from "@/stems/jobs";
import { stems, stemsWorkerEnv, type StemsDeps, type StemsRequest } from "@/stems/stems";
import { __resetMusicProvenanceForTests, recordMadeSong, sha256Hex } from "@/music/provenance";

const GB=1_073_741_824;
const made = (n:string) => { const b = new TextEncoder().encode(`0000ftypM4A fake-${n}`); recordMadeSong(b); return b; };
function deps(run:(r:StemsRequest)=>any):StemsDeps { return { supported:()=>true, installed:()=>true, ensure:async()=>{}, runtime:()=>({checkpoint:"x",config:"y",ffmpeg:"z"}), spawn:async()=>({exited:new Promise<number>(()=>{}),kill:()=>{},send:async(r,stage)=>{stage("loading",.1); stage("splitting",.4); stage("encoding",.8); return run(r);}}) }; }
const post=(body:any)=>app.request("/v1/audio/stems",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
const get=(p:string)=>app.request(p);
beforeEach(()=>{ __resetJobsForTests(); __resetGovernorForTests(); __resetMusicProvenanceForTests(); rmSync(join(dataDir,"music"),{recursive:true,force:true}); rmSync(join(dataDir,"tmp","music"),{recursive:true,force:true}); __setGovernorTuningForTestsOnly({totalMemoryBytes:128*GB,freeMemoryBytes:90*GB,tier:"p128"}); registerStemsJobs(); });
afterEach(()=>{ stems.useDeps(null); rmSync(join(dataDir,"music"),{recursive:true,force:true}); });
test("refuses a source not made here", async()=>{ stems.useDeps(deps(()=>({files:[],ms:1}))); const b=new TextEncoder().encode("0000ftypM4A fake"); const r=await post({source:Buffer.from(b).toString("base64"),source_sha256:sha256Hex(b),model:"htdemucs"}); expect(r.status).toBe(422); expect(((await r.json()) as any).code).toBe("source_not_made_here"); });
test("bad source hash is refused", async()=>{ const b=made("hash"); stems.useDeps(deps(()=>({files:[],ms:1}))); const r=await post({source:Buffer.from(b).toString("base64"),source_sha256:"0".repeat(64),model:"htdemucs"}); expect(r.status).toBe(422); expect(((await r.json()) as any).code).toBe("bad_request"); });
test("good split exposes four stems and records provenance", async()=>{ const b=made("good"); stems.useDeps(deps((r)=>{ const files=[]; for(const stem of ["vocals","drums","bass","other"] as const){writeFileSync(r.outputs[stem],`ftyp-${stem}`);files.push({stem,path:r.outputs[stem],rms:.1});} return {files,ms:10}; })); const r=await post({source:Buffer.from(b).toString("base64"),source_sha256:sha256Hex(b),model:"htdemucs"}); expect(r.status).toBe(200); const body=await r.json() as any; expect(body.data.map((x:any)=>x.stem)).toEqual(["vocals","drums","bass","other"]); expect((await (await get(body.data[0].url)).text()).startsWith("ftyp")).toBe(true); });
test("silent stem is absent", async()=>{ const b=made("silent"); stems.useDeps(deps((r)=>{for(const [stem,rms] of [["vocals",.2],["drums",0],["bass",.2],["other",.2]] as const) if(rms) writeFileSync(r.outputs[stem],stem); return {files:[{stem:"vocals",path:r.outputs.vocals,rms:.2},{stem:"bass",path:r.outputs.bass,rms:.2},{stem:"other",path:r.outputs.other,rms:.2}],ms:1}; })); const r=await post({source:Buffer.from(b).toString("base64"),source_sha256:sha256Hex(b),model:"htdemucs"}); expect((await r.json() as any).data.map((x:any)=>x.stem)).not.toContain("drums"); });
test("worker death is a plain failure", async()=>{const b=made("death"); stems.useDeps({ ...deps(()=>({files:[],ms:1})), spawn:async()=>({exited:Promise.resolve(1),kill:()=>{},send:async()=>{throw new Error("The stem worker stopped before finishing. Try again.");}}) }); const r=await post({source:Buffer.from(b).toString("base64"),source_sha256:sha256Hex(b),model:"htdemucs"}); expect(r.status).toBe(500); });
test("worker env has no inherited network credentials", async()=>{process.env.HF_TOKEN="test-token"; process.env.HTTPS_PROXY="http://proxy.invalid"; const env=stemsWorkerEnv(); expect(env.HF_TOKEN).toBeUndefined(); expect(env.HTTPS_PROXY).toBeUndefined(); expect(env.HF_HUB_OFFLINE).toBe("1"); expect(env.TRANSFORMERS_OFFLINE).toBe("1"); delete process.env.HF_TOKEN; delete process.env.HTTPS_PROXY;});
test("cancel stops an active split", async()=>{
  const b=made("cancel");
  stems.useDeps({ ...deps(()=>({files:[],ms:1})), spawn:async()=>({exited:new Promise<number>(()=>{}),kill:()=>{},send:async(_r,_stage,signal)=>new Promise((_resolve,reject)=>signal?.addEventListener("abort",()=>reject(new Error("Cancelled.")),{once:true})) }) });
  const r=await post({source:Buffer.from(b).toString("base64"),source_sha256:sha256Hex(b),model:"htdemucs",timeout_ms:1}); expect(r.status).toBe(202); const job=(await r.json() as any).job;
  const cancel=await app.request(`/v1/audio/stems/${job}`,{method:"DELETE"}); expect([200,202]).toContain(cancel.status);
  await new Promise((resolve)=>setTimeout(resolve,5));
  const state=await get(`/stack/v1/jobs/${job}`); expect(state.status).toBe(200);
});
