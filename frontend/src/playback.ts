import {midiOf,ticksOf,PPQ} from './core/music.mjs';
import type {Score} from './types';
export const noteSeconds=(score:Score,n:Score['measures'][number]['notes'][number])=>score.mode==='free'&&n.durationSeconds!==undefined?n.durationSeconds:ticksOf(n)/PPQ*60/score.tempo;
export function durationOf(score:Score){return score.measures.flatMap(m=>m.notes).reduce((s,n)=>s+noteSeconds(score,n),0);}
export async function playScore(score:Score,onTime:(t:number)=>void,onEnd:()=>void,original?:HTMLAudioElement|null,sourceOffset=0,sourceTempo?:number){
  const ctx=new AudioContext();await ctx.resume();
  const start=ctx.currentTime+0.1;
  let cursor=0;
  const notes=score.measures.flatMap(m=>m.notes);
  for(let i=0;i<notes.length;i++){
    const n=notes[i],midi=midiOf(n,score.key);
    let duration=noteSeconds(score,n);
    // Joined ties represent one sustained sounding note.
    while(n.tie&&i+1<notes.length&&midiOf(notes[i+1],score.key)===midi) {
      const current=notes[i];if(!current.tie)break;
      i++;duration+=noteSeconds(score,notes[i]);
    }
    if(midi!==null){
      const oscillator=ctx.createOscillator(),gain=ctx.createGain();
      oscillator.type='triangle';oscillator.frequency.value=440*Math.pow(2,(midi-69)/12);
      oscillator.connect(gain);gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0,start+cursor);gain.gain.linearRampToValueAtTime(0.15,start+cursor+0.01);
      gain.gain.setValueAtTime(0.12,start+cursor+Math.max(0.01,duration-0.04));
      gain.gain.linearRampToValueAtTime(0,start+cursor+duration);
      oscillator.start(start+cursor);oscillator.stop(start+cursor+duration+0.02);
    }
    cursor+=duration;
  }
  if(original){
    original.currentTime=sourceOffset;
    original.playbackRate=score.mode==='free'?1:score.tempo/(sourceTempo||score.tempo);
    original.preservesPitch=true;
    void original.play().catch(()=>{});
  }
  let stopped=false;
  const stop=()=>{if(stopped)return;stopped=true;clearInterval(timer);original?.pause();void ctx.close();onEnd();};
  const timer=setInterval(()=>{const t=Math.max(0,ctx.currentTime-start);onTime(t);if(t>=cursor)stop();},50);
  return stop;
}
