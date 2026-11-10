import { Worker } from 'node:worker_threads';
export const MAX_BYTES=20*1024*1024;
export function audioType(buffer) {
  if(buffer.length>MAX_BYTES||buffer.length<16) throw Object.assign(new Error('音频须为有效 MP3/WAV，最大 20 MB'),{status:400});
  if(buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WAVE') return 'audio/wav';
  if(buffer.toString('ascii',0,3)==='ID3'||(buffer[0]===255&&(buffer[1]&224)===224)) return 'audio/mpeg';
  throw Object.assign(new Error('只支持 MP3、WAV 音频文件'),{status:400});
}
export async function validateAudio(buffer) {
  const type=audioType(buffer);
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./audio-check.mjs',import.meta.url),{workerData:buffer,resourceLimits:{maxOldGenerationSizeMb:256}});
    let settled=false;
    const end=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);void worker.terminate();error?reject(Object.assign(new Error(error),{status:400})):resolve({type,...value});};
    const timer=setTimeout(()=>end('音频解码超时，请缩短录音后重试'),15000);
    worker.once('message',m=>m.ok?end(null,m):end('音频损坏、静音或超过 3 分钟'));
    worker.once('error',()=>end('音频无法解码'));
    worker.once('exit',code=>{if(!settled)end('音频解码未完成');});
  });
}