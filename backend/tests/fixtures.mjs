export function wav({seconds=4,frequencies=[261.6256,293.6648,329.6276,349.2282,391.9954,440,493.8833,523.2511],sampleRate=16000,silent=false}={}) {
  const count=Math.ceil(seconds*sampleRate),buffer=Buffer.alloc(44+count*2);
  buffer.write('RIFF',0);buffer.writeUInt32LE(36+count*2,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);
  buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(sampleRate,24);buffer.writeUInt32LE(sampleRate*2,28);
  buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(count*2,40);
  for(let i=0;i<count;i++){
    const t=i/sampleRate,segment=seconds/frequencies.length,index=Math.min(frequencies.length-1,Math.floor(t/segment)),local=t-index*segment;
    const envelope=Math.min(1,local/0.015)*Math.min(1,Math.max(0,(segment-0.03-local)/0.015));
    const v=silent?0:0.45*Math.sin(2*Math.PI*frequencies[index]*t)*envelope;
    buffer.writeInt16LE(Math.round(v*32767),44+i*2);
  }
  return buffer;
}
export function signal(buffer){
  return Float32Array.from({length:(buffer.length-44)/2},(_,i)=>buffer.readInt16LE(44+i*2)/32768);
}
