import { parentPort, workerData } from 'node:worker_threads';
import decodeWav from '@audio/decode-wav';
import decodeMp3 from '@audio/decode-mp3';
try {
  const bytes=new Uint8Array(workerData);
  const b=await (bytes[0]===82?decodeWav(bytes):decodeMp3(bytes));
  const channels=b.channelData || Array.from({length:b.numberOfChannels},(_,i)=>b.getChannelData(i));
  const duration=(channels[0]?.length||0)/b.sampleRate;
  if(!Number.isFinite(duration)||duration<=0||duration>180) throw new Error('录音时长须大于 0 且不超过 3 分钟');
  let energy=0;
  for(const channel of channels) for(let i=0;i<channel.length;i+=64) energy+=channel[i]*channel[i];
  if(energy<1e-9) throw new Error('录音为空或完全静音');
  parentPort.postMessage({ok:true,duration});
} catch { parentPort.postMessage({ok:false}); }