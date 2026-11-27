import { describe, expect, it, beforeAll, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import { db } from "@/db";
import { mediaSegments } from "@/db/schema";
import { setSegmentDepsForTests, resetSegmentDepsForTests, runSegmentsForTests, SEGMENTS_PIPELINE_VERSION, correctSegment, getSegments, fetchSegmentBytesForTests } from "./service";
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
    const oldFetch=globalThis.fetch; let seenAgent="";
    globalThis.fetch=(async(_input: string | URL | Request,init?: RequestInit)=>{seenAgent=new Headers(init?.headers).get("user-agent")??"";return new Response(new Uint8Array([1]));}) as unknown as typeof fetch;
    const bytes=await fetchSegmentBytesForTests("http://127.0.0.1/audio.mp3", undefined, undefined, true);
    globalThis.fetch=oldFetch;
    expect([...bytes]).toEqual([1]); expect(seenAgent).toBe("MaiPai-Stack/1");
  });
  it("fetches with injected stand-ins, persists by hash and returns the cached record",async()=>{
    const dir=join(dataDir,"segments-fixture");mkdirSync(dir,{recursive:true});const bytes=new Uint8Array(Buffer.from("fixture bytes"));let fetches=0,transcribes=0;
    setSegmentDepsForTests({fetch:async()=>{fetches++;return bytes;},probe:async()=>({duration_s:100,has_audio:true} as never),transcribe:async()=>{transcribes++;return {language:"en",segments:[{start:10,end:20,text:"hello",words:[]}],vocabulary_applied:false};},detect:async()=>[],chat:async()=>"[]"});
    const first=await runSegmentsForTests(job({url:"https://example.test/audio.mp3"}),new AbortController().signal,()=>{});
    const second=await runSegmentsForTests(job({url:"https://example.test/audio.mp3"}),new AbortController().signal,()=>{});
    expect(first.fileSha256).toBe(second.fileSha256);expect(first.producedBy.pipelineVersion).toBe(SEGMENTS_PIPELINE_VERSION);expect(fetches).toBe(2);expect(transcribes).toBe(1);expect(getSegments(first.fileSha256)?.segments).toEqual([]);
    rmSync(dir,{recursive:true,force:true});
  });
  it("records a person correction without person identity",()=>{
    const hash="a".repeat(64); const record={fileSha256:hash,durationSec:60,segments:[{id:"s1",kind:"ad",startSec:5,endSec:15,confidence:0.9,source:"llm",status:"auto"}],producedBy:{transcriptRevision:"r1",modelId:"m1",pipelineVersion:"1",createdAt:new Date().toISOString()}};
    db.insert(mediaSegments).values({fileSha256:hash,pipelineVersion:"1",recordJson:JSON.stringify(record),sourcePath:"/tmp/audio",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}).run();
    const corrected=correctSegment(hash,"s1","rejected");expect(corrected?.segments[0]?.status).toBe("rejected");expect(corrected?.segments[0]?.source).toBe("person");
  });
});

