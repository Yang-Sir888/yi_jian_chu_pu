import {PPQ,KEY_OFFSETS,ticksOf} from './constants.mjs';
let counter=0;
export const newId=(prefix='n')=>prefix+'-'+(++counter);
export function updateNote(score,sel,patch){return {...score,measures:score.measures.map((m,mi)=>mi!==sel.measureIndex?m:{...m,notes:m.notes.map((n,ni)=>ni!==sel.noteIndex?n:{...n,...(('base' in patch||'dots' in patch)?{exactTicks:undefined}:{}),...patch})})};}
const scale=[0,2,4,5,7,9,11];
export function respellScore(score,key){
 const shift=(KEY_OFFSETS[key]??0)-(KEY_OFFSETS[score.key]??0);
 return {...score,key,measures:score.measures.map(m=>({...m,notes:m.notes.map(n=>{
  if(!n.pitch)return n;
  const relative=scale[n.pitch-1]+(n.accidental==='#'?1:n.accidental==='b'?-1:0)+n.octave*12-shift;
  const octave=Math.floor(relative/12),pc=((relative%12)+12)%12;
  let degree=scale.indexOf(pc),accidental='';
  if(degree<0){degree=scale.indexOf(pc-1);accidental='#';}
  return {...n,pitch:degree+1,octave,accidental};
 })}))};
}
const choices=[1,2,4,8,16,32,64,128].flatMap(base=>[1,1.5,1.75].map((f,dots)=>({base,dots,ticks:4*PPQ/base*f}))).filter(c=>c.ticks%30===0).sort((a,b)=>b.ticks-a.ticks);
function pieces(ticks){
 const out=[];let left=ticks;
 while(left>0){const c=choices.find(x=>x.ticks<=left);if(!c){out.push({base:128,dots:0,ticks:left,exactTicks:left});break;}out.push(c);left-=c.ticks;}return out;
}
export const normalizeDotted=score=>structuredClone(score);
export function rebarScore(score,meter){
 const cap=meter[0]*4*PPQ/meter[1],measures=[];let bar=[],used=0;
 const flush=()=>{if(bar.length)measures.push({id:newId('bar'),notes:bar});bar=[];used=0;};
 for(const note of score.measures.flatMap(m=>m.notes)){
  const total=ticksOf(note);let remaining=total;const group=[];
  while(remaining>0){
   if(used>=cap)flush();const take=Math.min(remaining,cap-used);
   const chunks=take===total?[{base:note.base,dots:note.dots,ticks:take,exactTicks:note.exactTicks}]:pieces(take);
   for(const p of chunks){const n={...note,id:newId('n'),base:p.base,dots:p.dots,exactTicks:p.exactTicks,tie:false,durationSeconds:note.durationSeconds===undefined?undefined:note.durationSeconds*p.ticks/total};bar.push(n);group.push(n);}
   used+=take;remaining-=take;
  }
  group.forEach((n,i)=>{n.tie=note.pitch!==0&&(i<group.length-1||note.tie);});
 }
 flush();if(measures.length)measures.at(-1).barline='end';
 return {...score,meter:[...meter],mode:'metered',subtitle:'按拍整理 · 请对照原曲核校',estimates:{...score.estimates,meter:false},measures};
}
