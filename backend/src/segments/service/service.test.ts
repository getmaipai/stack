import { describe, expect, it, beforeAll, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, readdirSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import { db } from "@/db";
import { mediaSegments, learnedBumpers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { setSegmentDepsForTests, resetSegmentDepsForTests, runSegmentsForTests, runSegmentsSingleFlightForTests, SEGMENTS_PIPELINE_VERSION, SEGMENTS_MAX_FETCH_BYTES, SEGMENTS_STORE_CAP_BYTES, correctSegment, getSegments, fetchSegmentBytesForTests, setSegmentNetworkForTests, validateSegmentPathForTests, segmentStoredFileNameForTests, segmentMediaStoreDirForTests, enforceSegmentStoreCapForTests } from "./service";
import { setRoots, __resetRootsForTests } from "@/media/paths";
import type { Job } from "@/lib/jobs";
import { setMediaDepsForTests, resetMediaDepsForTests } from "@/media/jobs";

beforeAll(async()=>{ await import("@/app"); });
beforeEach(()=>{ resetSegmentDepsForTests(); resetMediaDepsForTests(); setMediaDepsForTests({toolbox:{path:async()=>"stub"} as never}); db.delete(mediaSegments).run(); });
const job=(input:Record<string,unknown>)=>({id:"segments-test",kind:"media.segments",role:null,state:"running",createdAt:new Date().toISOString(),input} as unknown as Job);

describe("media.segments service wiring",()=>{
  it("refuses a private DNS answer before the stand-in fetcher is called", async()=>{
    let calls=0;
    const oldFetch=globalThis.fetch;
    globalThis.fetch=(async()=>{calls++;return new Response("ok");}) as unknown as typeof fetch;
    await expect(fetchSegmentBytesForTests("http://127.0.0.1/audio.mp3")).rejects.toThrow(/not allowed/);
    globalThis.fetch=oldFetch;
    expect(calls).toBe(0);
  });
  it("validates redirect hops and supports explicit private opt-in in the fetch adapter", async()=>{
    let seenAgent="";setSegmentNetworkForTests({resolve:async()=>[{address:"8.8.8.8",family:4}],request:async(_url,_ip,agent)=>{seenAgent=agent;return {status:200,headers:new Headers({"content-type":"audio/mpeg"}),body:new Response(new Uint8Array([1])).body};}});
    const bytes=await fetchSegmentBytesForTests("http://127.0.0.1/audio.mp3", undefined, undefined, true);
    expect([...bytes]).toEqual([1]); expect(seenAgent).toBe("MaiPai-Stack/1");
  });
  it("rejects a public-then-private DNS answer without making a request",async()=>{let requests=0;setSegmentNetworkForTests({resolve:async()=>[{address:"8.8.8.8",family:4},{address:"127.0.0.1",family:4}],request:async()=>{requests++;return {status:200,headers:new Headers(),body:null};}});await expect(fetchSegmentBytesForTests("http://media.example/audio.mp3")).rejects.toThrow(/not allowed/);expect(requests).toBe(0);});
  it("rejects unsafe address spellings, userinfo, schemes and ports",async()=>{for(const url of ["http://2130706433/a","http://0x7f000001/a","http://0177.0.0.1/a","http://[::ffff:127.0.0.1]/a","http://[fe80::1]/a","http://user:pass@example.test/a","file:///tmp/a","http://example.test:8080/a"]){await expect(fetchSegmentBytesForTests(url)).rejects.toThrow();}});
  it("rejects unsupported content types and enforces streamed byte limits",async()=>{setSegmentNetworkForTests({resolve:async()=>[{address:"8.8.8.8",family:4}],request:async()=>({status:200,headers:new Headers({"content-type":"text/html"}),body:new Response("x").body})});await expect(fetchSegmentBytesForTests("http://media.example/a")).rejects.toThrow(/content type/);setSegmentNetworkForTests({request:async()=>({status:200,headers:new Headers({"content-type":"audio/mpeg"}),body:new ReadableStream({start(c){c.enqueue(new Uint8Array(SEGMENTS_MAX_FETCH_BYTES));c.enqueue(new Uint8Array([1]));c.close();}})})});await expect(fetchSegmentBytesForTests("http://media.example/a")).rejects.toThrow(/250 MB/);});
  it("enforces the fetch time cap, media store cap and hash-only filenames",async()=>{let cancelled=false;let t=10;setSegmentNetworkForTests({resolve:async()=>[{address:"8.8.8.8",family:4}],now:()=>t,request:async()=>({status:200,headers:new Headers({"content-type":"audio/mpeg"}),body:new ReadableStream({async pull(c){t+=31_000;c.enqueue(new Uint8Array([1]));},cancel(){cancelled=true;}})})});await expect(fetchSegmentBytesForTests("http://media.example/a")).rejects.toThrow(/too long/);expect(cancelled).toBe(true);expect(segmentStoredFileNameForTests("a".repeat(64))).toEndWith(`${"a".repeat(64)}.audio`);expect(()=>segmentStoredFileNameForTests("../../escape")).toThrow();const dir=segmentMediaStoreDirForTests();writeFileSync(join(dir,"cap-fixture"),"x");expect(()=>enforceSegmentStoreCapForTests(SEGMENTS_STORE_CAP_BYTES+1)).toThrow(/cache is full/);});
  it("fetches with injected stand-ins, persists by hash and returns the cached record",async()=>{
    const dir=join(dataDir,"segments-fixture");mkdirSync(dir,{recursive:true});const bytes=new Uint8Array(Buffer.from("fixture bytes"));let fetches=0,transcribes=0;
    setSegmentDepsForTests({fetch:async()=>{fetches++;return bytes;},probe:async()=>({duration_s:100,has_audio:true} as never),transcribe:async()=>{transcribes++;return {language:"en",segments:[{start:10,end:20,text:"hello",words:[]}],vocabulary_applied:false};},detect:async()=>[],chat:async()=>"[]"});
    const first=await runSegmentsForTests(job({url:"https://example.test/audio.mp3"}),new AbortController().signal,()=>{});
    const second=await runSegmentsForTests(job({url:"https://example.test/audio.mp3"}),new AbortController().signal,()=>{});
    expect(first.fileSha256).toBe(second.fileSha256);expect(first.producedBy.pipelineVersion).toBe(SEGMENTS_PIPELINE_VERSION);expect(fetches).toBe(2);expect(transcribes).toBe(1);expect(getSegments(first.fileSha256)?.segments).toEqual([]);
    rmSync(dir,{recursive:true,force:true});
  });
  it("adds grouped bumper segments from decoded audio and stores the learned bumper per show",async()=>{
    const rate=16000,pcm=new Int16Array(rate*12); let seed=99;
    const noise=()=>{seed=(Math.imul(seed,1103515245)+12345)>>>0;return ((seed>>>8)/16777216-0.5)*6000;};
    for(let i=0;i<pcm.length;i++) pcm[i]=noise();
    const stinger=(start:number,secs:number)=>{for(let i=0;i<secs*rate;i++){const t=i/rate;pcm[start*rate+i]=Math.round(9000*(Math.sin(2*Math.PI*(700+400*t)*t)+0.6*Math.sin(2*Math.PI*1900*t)));}};
    for(const [a,b] of [[2,3],[7,8]] as const){stinger(a-0.8,0.8);pcm.fill(0,a*rate,(a+0.95)*rate);stinger(a+0.95,1.0);void b;}
    const dir=join(dataDir,"segments-bumper-fixture");mkdirSync(dir,{recursive:true});const bytes=new Uint8Array(Buffer.from("bumper fixture bytes"));
    setSegmentDepsForTests({fetch:async()=>bytes,probe:async()=>({duration_s:12,has_audio:true} as never),transcribe:async()=>({language:"en",segments:[{start:0,end:1,text:"hello",words:[]}],vocabulary_applied:false}),detect:async()=>[],chat:async()=>"[]",decodePcm:async()=>pcm});
    const record=await runSegmentsForTests(job({url:"https://example.test/bumper.mp3",showKey:"show-a"}),new AbortController().signal,()=>{});
    const bumpers=record.segments.filter(x=>x.kind==="bumper");
    expect(bumpers.filter(x=>x.slotRole==="slot")).toHaveLength(2);
    for(const role of ["lead-stinger","tail-stinger"] as const) expect(bumpers.filter(x=>x.slotRole===role)).toHaveLength(2);
    const groups=new Set(bumpers.map(x=>x.groupId)); expect(groups.size).toBe(2);
    const lead=bumpers.find(x=>x.slotRole==="lead-stinger")!; expect(lead.endSec-lead.startSec).toBeGreaterThanOrEqual(0.75); expect(lead.endSec-lead.startSec).toBeLessThanOrEqual(1.1);
    const stored=db.select().from(learnedBumpers).where(eq(learnedBumpers.showKey,"show-a")).get(); expect(stored).toBeTruthy();
    rmSync(dir,{recursive:true,force:true});
  });
  it("records a person correction without person identity",()=>{
    const hash="a".repeat(64); const record={fileSha256:hash,durationSec:60,segments:[{id:"s1",kind:"ad",startSec:5,endSec:15,confidence:0.9,source:"llm",status:"auto"}],producedBy:{transcriptRevision:"r1",modelId:"m1",pipelineVersion:"1",createdAt:new Date().toISOString()}};
    db.insert(mediaSegments).values({fileSha256:hash,pipelineVersion:"1",recordJson:JSON.stringify(record),sourcePath:"/tmp/audio",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}).run();
    const corrected=correctSegment(hash,"s1","rejected");expect(corrected?.segments[0]?.status).toBe("rejected");expect(corrected?.segments[0]?.source).toBe("person");
  });
  it("preserves confirmed and rejected overlapping segments after rerunning",async()=>{const hash="b".repeat(64),bytes=new Uint8Array(Buffer.from("same"));let segment=[{id:"auto",kind:"ad" as const,startSec:10,endSec:20,confidence:.9,source:"llm" as const,status:"auto" as const}];setSegmentDepsForTests({fetch:async()=>bytes,probe:async()=>({duration_s:60,has_audio:true} as never),transcribe:async()=>({language:"en",segments:[{start:1,end:2,text:"x",words:[]}],vocabulary_applied:false}),detect:async()=>segment as never,chat:async()=>"[]"});const first=await runSegmentsForTests(job({url:"https://example.test/a"}),new AbortController().signal,()=>{});correctSegment(first.fileSha256,first.segments[0]!.id,"confirmed");segment=[{...segment[0]!,id:"new-auto"}];const next=await runSegmentsForTests(job({url:"https://example.test/a"}),new AbortController().signal,()=>{});expect(next.segments.some(s=>s.status==="confirmed"&&s.source==="person")).toBe(true);});
  it("single-flights concurrent same-file jobs",async()=>{let calls=0,release!:()=>void;const gate=new Promise<void>(r=>release=r);setSegmentDepsForTests({fetch:async()=>new Uint8Array([1]),probe:async()=>({duration_s:60,has_audio:true} as never),transcribe:async()=>{calls++;await gate;return {language:"en",segments:[{start:1,end:2,text:"x",words:[]}],vocabulary_applied:false};},detect:async()=>[],chat:async()=>"[]"});const input={url:"https://example.test/same"};const a=runSegmentsSingleFlightForTests(job(input),new AbortController().signal,()=>{});await Promise.resolve();const b=runSegmentsSingleFlightForTests(job(input),new AbortController().signal,()=>{});release();expect(await a).toEqual(await b);expect(calls).toBe(1);});
  it("cancellation aborts downstream work and removes the staged partial file",async()=>{const controller=new AbortController();const bytes=new Uint8Array(Buffer.from("cancel-fixture"));setSegmentDepsForTests({fetch:async(_u,_a,signal)=>{signal.addEventListener("abort",()=>{}, {once:true});controller.abort();return bytes;},probe:async()=>{throw new Error("should not probe after cancel");}});await expect(runSegmentsForTests(job({url:"https://example.test/cancel"}),controller.signal,()=>{})).rejects.toThrow(/Cancelled/);expect(readdirSync(segmentMediaStoreDirForTests()).some(name=>name.endsWith(".partial"))).toBe(false);});
  it("aborts and reaps ffprobe, ffmpeg render, and feature decode child work",async()=>{
    const root=mkdtempSync(join(tmpdir(),"segments-child-cancel-")), media=join(root,"source.mp3"), ref=join(root,"reference.mp3");writeFileSync(media,"source");writeFileSync(ref,"reference");setRoots({read:[root]});
    const controller=new AbortController(), killed:string[]=[], exited:string[]=[];
    const runner=async(argv:string[],options?:{signal?:AbortSignal})=>new Promise<{code:number|null;stdout:string;stderr:string;aborted:boolean}>(resolve=>{
      const name=argv[0]!.includes("ffprobe")?"ffprobe":argv[0]!.includes("ffmpeg")?"ffmpeg":"child";
      const reap=()=>{killed.push(name);exited.push(name);resolve({code:null,stdout:"",stderr:"",aborted:true});};
      if(options?.signal?.aborted)reap();else options?.signal?.addEventListener("abort",reap,{once:true});
    });
    setSegmentDepsForTests({runner,probe:async(_run,_ffprobe,_path,signal)=>{await runner(["ffprobe","-i",media],{signal});throw new Error("probe stopped");},decodeFeatures:async(_path,signal)=>new Promise((_resolve,reject)=>{const reap=()=>{killed.push("feature decode");exited.push("feature decode");reject(new Error("Cancelled."));};if(signal.aborted)reap();else signal.addEventListener("abort",reap,{once:true});})});
    const probeRun=runSegmentsForTests(job({path:media}),controller.signal,()=>{});await Bun.sleep(0);controller.abort();await expect(probeRun).rejects.toThrow(/Cancelled/);
    expect(killed).toContain("ffprobe");expect(exited).toEqual(killed);
    const featureController=new AbortController();setSegmentDepsForTests({probe:async()=>({duration_s:60,has_audio:true} as never),transcribe:async()=>({language:"en",segments:[{start:1,end:2,text:"x",words:[]}],vocabulary_applied:false}),detect:async()=>[],decodeFeatures:async(_path,signal)=>new Promise((_resolve,reject)=>{const reap=()=>{killed.push("feature decode");exited.push("feature decode");reject(new Error("Cancelled."));};if(signal.aborted)reap();else signal.addEventListener("abort",reap,{once:true});})});
    const featureRun=runSegmentsForTests(job({path:media,referencePath:ref}),featureController.signal,()=>{});await Bun.sleep(0);featureController.abort();await expect(featureRun).rejects.toThrow(/Cancelled/);
    expect(killed).toContain("feature decode");expect(exited).toEqual(killed);rmSync(root,{recursive:true,force:true});
  });
  it("requires local inputs to pass the shared media root and rejects traversal and symlink escape",()=>{const root=mkdtempSync(join(tmpdir(),"segments-path-")),outside=mkdtempSync(join(tmpdir(),"segments-outside-"));const file=join(root,"x.mp3"),escaped=join(root,"escape.mp3");writeFileSync(file,"audio");writeFileSync(join(outside,"secret.mp3"),"secret");symlinkSync(join(outside,"secret.mp3"),escaped);setRoots({read:[root]});expect(validateSegmentPathForTests(file)).toEndWith("/x.mp3");expect(()=>validateSegmentPathForTests(join(root,"..","outside"))).toThrow();expect(()=>validateSegmentPathForTests(escaped)).toThrow();__resetRootsForTests();rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});});
});

