import { KEY_NAMES } from './music.mjs';
export function assertScore(s) {
  const fail = () => { throw Object.assign(new Error('谱面数据无效或超出限制'), {status:400}); };
  if (!s || typeof s !== 'object' || !Array.isArray(s.measures) || s.measures.length > 500 ||
      !KEY_NAMES.includes(s.key) || !Number.isInteger(s.tempo) || s.tempo < 40 || s.tempo > 200 ||
      !Array.isArray(s.meter) || ![[2,4],[3,4],[4,4],[6,8]].some(m => m[0]===s.meter[0] && m[1]===s.meter[1])) fail();
  for (const key of ['title','subtitle','artist','lyricist','composer']) {
    if (s[key] !== undefined && (typeof s[key] !== 'string' || s[key].length>200)) fail();
  }
  if(s.estimates!==undefined&&(!s.estimates||typeof s.estimates!=='object'||Object.values(s.estimates).some(v=>typeof v!=='boolean')))fail();
  if(s.mode!==undefined&&!['free','metered'].includes(s.mode))fail();
  let count=0;
  for (const m of s.measures) {
    if (!m || typeof m.id!=='string' || m.id.length>100 || !Array.isArray(m.notes) || m.notes.length>300) fail();
    for (const n of m.notes) {
      for(const k of ['durationSeconds','sourceStart','sourceEnd','exactTicks'])if(n[k]!==undefined&&(!Number.isFinite(n[k])||n[k]<0||n[k]>(k==='exactTicks'?20000:181)))fail();
      if(n.review!==undefined&&(typeof n.review!=='string'||n.review.length>500))fail();
      if(n.sourceId!==undefined&&(typeof n.sourceId!=='string'||n.sourceId.length>100))fail();
      if (++count>10000 || typeof n.id!=='string' || n.id.length>100 ||
          !Number.isInteger(n.pitch) || n.pitch<0 || n.pitch>7 ||
          !Number.isInteger(n.octave) || Math.abs(n.octave)>4 ||
          !['','#','b'].includes(n.accidental) || ![1,2,4,8,16,32,64,128].includes(n.base) ||
          ![0,1,2].includes(n.dots) || typeof n.tie!=='boolean' ||
          (n.lyric!==undefined && (typeof n.lyric!=='string' || n.lyric.length>30))) fail();
    }
  }
  return s;
}
export function assertWork(data) {
  if (!data || typeof data !== 'object') throw Object.assign(new Error('作品数据无效'), {status:400});
  assertScore(data.score); assertScore(data.original);
  if (typeof data.instruction!=='string' || data.instruction.length>2000 ||
      !['basic-pitch','yin','demo','manual'].includes(data.engine) ||
      !Array.isArray(data.events) || data.events.length>300 ||
      typeof data.report!=='string' || data.report.length>10000) throw Object.assign(new Error('作品数据无效'), {status:400});
  for (const e of data.events) {
    if (!e || !['stage','tool','warn','done'].includes(e.kind) || typeof e.text!=='string' || e.text.length>2000) {
      throw Object.assign(new Error('操作记录格式无效'), {status:400});
    }
  }
  if(data.rawEvents!==undefined&&(!Array.isArray(data.rawEvents)||data.rawEvents.length>5000||data.rawEvents.some(e=>!e||typeof e.id!=='string'||e.id.length>100||![e.start,e.end,e.midi,e.clarity].every(Number.isFinite)||e.start<0||e.end<e.start||e.end>181||e.midi<0||e.midi>127)))throw Object.assign(new Error('原始事件格式无效'),{status:400});
  return {rawEvents:data.rawEvents||[],review:Array.isArray(data.review)?data.review.slice(0,100):[],reviewEngine:typeof data.reviewEngine==='string'?data.reviewEngine.slice(0,80):'none',score:data.score, original:data.original, instruction:data.instruction, engine:data.engine, events:data.events, report:data.report,
    sourceOffset:typeof data.sourceOffset==='number'&&Number.isFinite(data.sourceOffset)&&data.sourceOffset>=0&&data.sourceOffset<=180?data.sourceOffset:0,
    modelStatus:['success','failed','unconfigured','not_run'].includes(data.modelStatus)?data.modelStatus:'not_run'};
}
