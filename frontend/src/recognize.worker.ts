import type {RawEvent} from './types';
import {melodyEvents,eventsToScore} from './core/transcription.mjs';
import {analyzeFrames,segmentNotes,estimateTempo} from './core/analysis.mjs';
self.onmessage=async message=>{
 const {data,duration,sampleRate,title,engine,reviewWithCrepe=false,mode='metered'}=message.data;
 const send=(stage:string,value:number)=>self.postMessage({kind:'progress',value,stage});
 try{
  let raw:RawEvent[]=[],review:any[]=[];
  if(engine==='yin'){
   send('YIN 备用识别',.1);const frames=analyzeFrames(data,sampleRate);
   raw=segmentNotes(frames.frames,frames.rmsGate,.025).map((n,i)=>({...n,id:'yin-'+i,review:n.end-n.start<.08?'短音，请核对':undefined}));
  }else{
   const tf=await import('@tensorflow/tfjs-core');
   tf.env().setPlatform('worker',{fetch:(u,i)=>fetch(u,i),now:()=>performance.now(),encode:t=>new TextEncoder().encode(t),decode:(b,e)=>new TextDecoder(e).decode(b),setTimeoutCustom:(f,d)=>{setTimeout(f,d);}});
   const {BasicPitch,outputToNotesPoly,noteFramesToTime}=await import('@spotify/basic-pitch');
   await tf.setBackend('cpu');await tf.ready();
   const tracker=new BasicPitch('/basic-pitch/model.json');const graph=await tracker.model;
   try{
    // Model weights live outside scopes. Release intermediate tensors after each short chunk.
    for(let at=0;at<duration;at+=8){
     const lo=Math.max(0,at-.3),hi=Math.min(duration,at+8+.3),frames:number[][]=[],onsets:number[][]=[];
     tf.engine().startScope();
     try{
      await tracker.evaluateModel(data.subarray(Math.round(lo*sampleRate),Math.round(hi*sampleRate)),(f,o)=>{frames.push(...f);onsets.push(...o);},p=>send('Basic Pitch 识别',Math.min(.8,(at+p*8)/duration*.8)));
      const candidates=noteFramesToTime(outputToNotesPoly(frames,onsets,.25,.25,1)).map(n=>({...n,startTimeSeconds:n.startTimeSeconds+lo}));
      for(const n of melodyEvents(candidates)){
       if(n.end<=at||n.start>=at+8)continue;
       const event={...n,id:'bp-'+raw.length,start:Math.max(at,n.start),end:Math.min(at+8,n.end)};
       const prev=raw.at(-1);
       if(prev&&prev.midi===event.midi&&Math.abs(prev.end-event.start)<.003&&n.start<at-.03)prev.end=event.end;
       else raw.push(event);
      }
     }finally{tf.engine().endScope();}
     await new Promise(resolve=>setTimeout(resolve,0));
    }
   }finally{graph.dispose();}
   if(reviewWithCrepe&&raw.length){
    send('加载 CREPE 实验复核模型',.81);
    const {loadLayersModel}=await import('@tensorflow/tfjs-layers');
    const model=await loadLayersModel('/crepe/model.json');
    try{
     // Only review uncertain events, with a bounded, serial sample budget.
     const selected=raw.filter(n=>n.review||n.clarity<.6).slice(0,100);
     if(!selected.length)selected.push(...raw.filter((_,i)=>i%Math.max(1,Math.floor(raw.length/24))===0).slice(0,24));
     for(let i=0;i<selected.length;i++){
      const n=selected[i],center=(n.start+n.end)/2;
      const values=new Float32Array(1024);for(let j=0;j<1024;j++){const position=(center+(j-512)/16000)*sampleRate;const a=Math.floor(position),f=position-a;values[j]=(data[a]||0)*(1-f)+(data[a+1]||0)*f;}
      let mean=0;for(const v of values)mean+=v/1024;let energy=0;for(let j=0;j<1024;j++){values[j]-=mean;energy+=values[j]*values[j];}const std=Math.sqrt(energy/1024);if(std<.002)continue;for(let j=0;j<1024;j++)values[j]/=std;
      const activation=tf.tidy(()=>{const input=tf.tensor2d(values,[1,1024]);const output=model.predict(input);return Array.from((Array.isArray(output)?output[0]:output).dataSync()) as number[];});
      let bin=0;for(let j=1;j<360;j++)if(activation[j]>activation[bin])bin=j;
      const confidence=activation[bin];let weighted=0,weight=0;for(let j=Math.max(0,bin-4);j<=Math.min(359,bin+4);j++){weighted+=activation[j]*(1997.3794084376191+j*20);weight+=activation[j];}
      const hz=10*2**(weighted/weight/1200),midi=69+12*Math.log2(hz/440);
      if(confidence>.5&&Math.abs(midi-n.midi)>.5){n.review='两个模型估音不一致，请核对；未自动改音';review.push({eventId:n.id,start:n.start,end:n.end,basicMidi:n.midi,crepeMidi:midi,confidence});}
      send('CREPE 片段复核',.82+(i+1)/Math.max(1,selected.length)*.16);
     }
    }finally{model.dispose();}
   }
  }
  if(!raw.length)throw new Error('未识别到有效旋律，请检查录音，或主动选择备用识别');
  if(raw.length>5000)throw new Error('音符数量过多，请截取较短片段');
  const tempo=Math.max(40,Math.min(200,Math.round(estimateTempo(raw).bpm)));
  const score=eventsToScore(raw,{title,tempo,mode});
  send('识别完成',1);self.postMessage({kind:'result',result:{score,offset:raw[0].start,rawEvents:raw,review,reviewEngine:reviewWithCrepe?'crepe-tiny-experimental':'none'}});
 }catch(e){self.postMessage({kind:'error',message:e instanceof Error?e.message:'识别未完成'});}
};
