import {PPQ,midiOf} from './constants.mjs';
import {spell} from './analysis.mjs';
const bases=[1,2,4,8,16,32,64,128],factors=[1,1.5,1.75];
export function splitDuration(ticks){
 const unit=30;let left=Math.round(ticks/unit)*unit;
 if(left<unit)left=unit;
 const choices=bases.flatMap(base=>factors.map((f,dots)=>({base,dots,ticks:4*PPQ/base*f}))).filter(x=>x.ticks%unit===0).sort((a,b)=>b.ticks-a.ticks);
 const out=[];while(left>0){const c=choices.find(x=>x.ticks<=left);out.push(c);left-=c.ticks;}return out;
}
export function melodyEvents(candidates){
 const input=candidates.map((n,i)=>({id:'e'+i,start:n.startTimeSeconds,end:n.startTimeSeconds+n.durationSeconds,midi:n.pitchMidi,clarity:n.amplitude}))
  .filter(n=>n.end>n.start&&n.end-n.start>=0.015&&n.start>=0&&n.end<=181&&n.midi>=21&&n.midi<=108);
 const boundaries=[...new Set(input.flatMap(n=>[n.start,n.end]))].sort((a,b)=>a-b),out=[];
 for(let i=0;i<boundaries.length-1;i++){
  const start=boundaries[i],end=boundaries[i+1];if(end-start<.002)continue;
  const active=input.filter(n=>n.start<=start+.00001&&n.end>=end-.00001).sort((a,b)=>b.clarity-a.clarity);
  if(!active.length)continue;const n=active[0],previous=out.at(-1);
  if(previous?.sourceId===n.id&&Math.abs(previous.end-start)<.003)previous.end=end;
  else out.push({...n,id:'raw'+out.length,sourceId:n.id,start,end,review:active.length>1?'候选音存在重叠，请对照原曲核对':undefined});
 }
 return out.map(n=>({...n,review:n.review||(n.end-n.start<.08?'短音或装饰音，请核对':n.clarity<.4?'模型响应较弱，请核对':undefined)}));
}
export function eventsToScore(events,{title='未命名作品',tempo=80,key='C',meter=[4,4],mode='metered',confirmed={}}={}){
 const raw=events.map(e=>({...e})).sort((a,b)=>a.start-b.start);
 if(!raw.length)return {title,key,meter,tempo,mode,estimates:{key:!confirmed.key,tempo:!confirmed.tempo,meter:!confirmed.meter},measures:[]};
 const root=['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B'].indexOf(key);
 const origin=raw[0].start,cap=meter[0]*4*PPQ/meter[1],scale=PPQ*tempo/60;
 let serial=0,cursor=0,used=0,bar=[];
 const measures=[];const flush=()=>{if(bar.length)measures.push({id:'bar-'+serial++,notes:bar});bar=[];used=0;};
 function append(event,ticks,rest=false){
  let remaining=ticks;
  while(remaining>0){
   if(mode==='metered'&&used>=cap)flush();
   const take=mode==='metered'?Math.min(remaining,cap-used):remaining;
   const pieces=splitDuration(take),displayTicks=pieces.reduce((s,p)=>s+p.ticks,0);
   for(let j=0;j<pieces.length;j++){
    const p=pieces[j];bar.push({id:'note-'+serial++,...(rest?{pitch:0,octave:0,accidental:''}:spell(event.midi,root)),base:p.base,dots:p.dots,
      tie:!rest&&(j<pieces.length-1||remaining>take),sourceId:event.id,sourceStart:event.start,sourceEnd:event.end,
      durationSeconds:mode==='free'?(event.end-event.start)*p.ticks/displayTicks:undefined,review:event.review});
   }
   used+=take;remaining-=take;
   if(mode==='free'&&bar.length>=8)flush();
  }
 }
 for(const event of raw){
  const start=Math.max(cursor,(mode==='free'?(event.start-origin)*scale:Math.round((event.start-origin)*scale/30)*30));
  if(start>cursor)append({id:'rest-'+serial,start:origin+cursor/scale,end:event.start},start-cursor,true);
  const end=mode==='free'?Math.max(start+.001,(event.end-origin)*scale):Math.max(start+30,Math.round((event.end-origin)*scale/30)*30);
  append(event,end-start);cursor=end;
 }
 flush();if(measures.length)measures.at(-1).barline='end';
 return {title,key,meter:[...meter],tempo,mode,estimates:{key:!confirmed.key,tempo:!confirmed.tempo,meter:!confirmed.meter},subtitle:mode==='free'?'自由节奏 · 时值符号为近似记谱':'自动识别草稿 · 调号、拍号及速度请确认',measures};
}
export function sourceEventsOfScore(score){
 let cursor=0;const events=[];
 for(const n of score.measures.flatMap(m=>m.notes)){const seconds=(n.durationSeconds??((4/n.base*PPQ*[1,1.5,1.75][n.dots])/PPQ*60/score.tempo));
  if(n.pitch!==0)events.push({id:n.id,start:cursor,end:cursor+seconds,midi:midiOf(n,score.key),clarity:1});cursor+=seconds;}
 return events;
}
