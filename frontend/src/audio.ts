import type {Score,Engine} from './types';
export function validateFile(file:File) {
  if(!/\.(mp3|wav)$/i.test(file.name))throw new Error('请选择 MP3 或 WAV 文件');
  if(file.size===0||file.size>20*1024*1024)throw new Error('录音不能为空，最大支持 20 MB');
}
export async function decodeFile(file:File,sampleRate:number){
  validateFile(file);
  const ctx=new AudioContext();
  try{
    let buffer:AudioBuffer;
    try{buffer=await ctx.decodeAudioData(await file.arrayBuffer());}catch{throw new Error('音频损坏或浏览器无法解码，请换用 WAV 文件');}
    if(buffer.duration>180||buffer.duration<0.1)throw new Error('录音时长须为 0.1 秒至 3 分钟');
    const offline=new OfflineAudioContext(1,Math.ceil(buffer.duration*sampleRate),sampleRate);
    const source=offline.createBufferSource();source.buffer=buffer;source.connect(offline.destination);source.start();
    const data=(await offline.startRendering()).getChannelData(0).slice();
    let energy=0;for(let i=0;i<data.length;i+=16)energy+=data[i]*data[i];
    if(energy<1e-8)throw new Error('录音为静音，请检查文件');
    return {data,duration:buffer.duration};
  }finally{await ctx.close();}
}
export async function recognize(file:File,engine:Engine,onProgress:(p:number)=>void,signal:AbortSignal,options:{reviewWithCrepe?:boolean;mode?:string;onStage?:(stage:string)=>void}={}):Promise<any> {
  if(signal.aborted)throw new Error('已取消识别');
  const sampleRate=engine==='yin'?8000:22050;
  const decoded=await decodeFile(file,sampleRate);
  if(signal.aborted)throw new Error('已取消识别');
  const worker=new Worker(new URL('./recognize.worker.ts',import.meta.url),{type:'module'});
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>finish(new Error('识别超时，请缩短录音，或选择 YIN 备用识别')),10*60*1000);
    const abort=()=>finish(new Error('已取消识别'));
    const finish=(error?:Error,result?:any)=>{clearTimeout(timeout);signal.removeEventListener('abort',abort);worker.terminate();error?reject(error):resolve(result);};
    signal.addEventListener('abort',abort,{once:true});
    worker.onmessage=e=>{
      if(e.data.kind==='progress'){onProgress(e.data.value);options.onStage?.(e.data.stage);}
      if(e.data.kind==='result')finish(undefined,e.data.result);
      if(e.data.kind==='error')finish(new Error(e.data.message));
    };
    worker.onerror=()=>finish(new Error('识别模型加载或运行失败，可选择 YIN 备用识别'));
    worker.postMessage({engine,reviewWithCrepe:options.reviewWithCrepe,mode:options.mode,...decoded,sampleRate,title:file.name.replace(/\.[^.]+$/,'').slice(0,120)},[decoded.data.buffer]);
  });
}
