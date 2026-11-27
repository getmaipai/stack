import { describe, expect, it } from "bun:test";
import { bumperCandidates, extentFromProfile, findDigitalSilences } from "./index";

function fixture(): Float32Array {
  const rate = 16000, audio = new Float32Array(rate * 12);
  const burst = (start: number, seconds: number, seed: number) => { let x=seed; for(let i=0;i<rate*seconds;i++){x=(x*16807)%2147483647;const white=x/1073741824-1; audio[start+i]=white+0.55*Math.sin(2*Math.PI*900*i/rate)+0.35*Math.sin(2*Math.PI*1500*i/rate);} };
  // Speech-like noise surrounds two slots; the pre- and post-silence stingers
  // have intentionally different lengths and repeat exactly across slots.
  burst(rate*0.2,0.8,1234567); audio.fill(0,rate,rate*1.95); burst(rate*1.95,1.0,7654321);
  burst(rate*4.2,0.8,1234567); audio.fill(0,rate*5,rate*5.95); burst(rate*5.95,1.0,7654321);
  // Speech-like background: every 50 ms a different mix of tones, so spectra differ from frame to frame (flat noise
  // would match everywhere). Stingers and the digital silences stay as built above.
  const stinger=(t:number)=>(t>=0.2&&t<1)||(t>=1.95&&t<2.95)||(t>=4.2&&t<5)||(t>=5.95&&t<6.95), silent=(t:number)=>(t>=1&&t<1.95)||(t>=5&&t<5.95);
  const tones=(blk:number)=>{ const out:number[][]=[]; let h=(blk*2654435761+12345)>>>0; for(let k=0;k<10;k++){ h=(Math.imul(h,1103515245)+12345)>>>0; const f=200+(h%6000); h=(Math.imul(h,1103515245)+12345)>>>0; out.push([f,0.04+(h%1000)/1000*0.25]); } return out; };
  const cache=new Map<number,number[][]>();
  for(let i=0;i<audio.length;i++){ const t=i/rate; if(stinger(t)||silent(t)) continue; const blk=Math.floor(i/(0.02*rate)); let tn=cache.get(blk); if(!tn){tn=tones(blk);cache.set(blk,tn);} let v=0; for(const [f,a] of tn) v+=a!*Math.sin(2*Math.PI*f!*i/rate); audio[i]=v*0.5; }
  return audio;
}

describe("bumper detection",()=>{
  it("finds two repeated synthetic slots and their stingers",()=>{
    const a=fixture(), silence=findDigitalSilences(a,16000);
    const out=bumperCandidates(a,silence,[],16000);
    expect(silence.filter(s=>s.endSec-s.startSec>0.2)).toHaveLength(2);
    expect(out.segments.filter(s=>s.slotRole==="slot")).toHaveLength(2);
    const leads=out.segments.filter(s=>s.slotRole==="lead-stinger"), tails=out.segments.filter(s=>s.slotRole==="tail-stinger");
    expect(leads).toHaveLength(2); expect(tails).toHaveLength(2);
    expect(leads.every(s=>Math.abs((s.endSec-s.startSec)-0.8)<0.15)).toBe(true);
    expect(tails.every(s=>Math.abs((s.endSec-s.startSec)-1.0)<0.15)).toBe(true);
    expect(out.learnedBumper).toHaveLength(2);
  });
  it("uses learned frames for one slot and keeps an unmatched lone silence weak",()=>{
    const a=fixture(), both=findDigitalSilences(a,16000).filter(s=>s.endSec-s.startSec>0.2), learned=bumperCandidates(a,both,[],16000).learnedBumper;
    const one=bumperCandidates(a,[both[0]!],learned,16000);
    expect(one.segments.some(s=>s.slotRole==="lead-stinger"&&s.confidence>=0.74)).toBe(true);
    const lone=bumperCandidates(new Float32Array(16000*3),[{startSec:1,endSec:1.95}],[],16000);
    expect(lone.segments.every(s=>s.confidence===0.4&&s.status==="held")).toBe(true);
  });
  it("ends the stinger where a 0.2 s run stops matching, bridging a short dip, and rejects a non-matching edge",()=>{
    const prof=(parts:Array<[number,number]>)=>parts.flatMap(([n,v])=>new Array<number>(n).fill(v));
    // 0.8 s of matching frames with a 40 ms dip inside, then speech (0.3): the cut must cover the whole stinger
    // and not run more than 0.3 s past it
    const dip=prof([[40,0.92],[4,0.3],[36,0.92],[200,0.3]]);
    expect(extentFromProfile(dip).length).toBeGreaterThanOrEqual(0.8); expect(extentFromProfile(dip).length).toBeLessThanOrEqual(1.1);
    // a longer 1.0 s stinger
    {const e=extentFromProfile(prof([[100,0.9],[200,0.3]])).length; expect(e).toBeGreaterThanOrEqual(1.0); expect(e).toBeLessThanOrEqual(1.3);}
    // edge that does not match (speech next to the silence): not a bumper
    expect(extentFromProfile(prof([[300,0.3]])).length).toBe(0);
    // the two verified real silences are read as slots of 0.95 and 0.96 s
    expect(findDigitalSilences(Int16Array.from({length:160000},(_,i)=>(i>=16000&&i<31200)?0:1000),16000)).toEqual([{startSec:1,endSec:1.95}]);
  });
});
