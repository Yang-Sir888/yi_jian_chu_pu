import {midiOf, ticksOf, PPQ} from './core/music.mjs';
import type {Score, Work} from './types';

const xml = (s: unknown) => String(s ?? '').replace(/[<>&"']/g, c => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'}[c]!));
const safeName = (title: string) => (title || '简谱').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 100);

export function download(data: BlobPart, title: string, extension: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], {type}));
  const a = document.createElement('a');
  a.href = url; a.download = safeName(title) + '.' + extension;
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// Standard MIDI format 0: one monophonic track, with tempo and meter metadata.
export function midiBytes(score: Score): Uint8Array {
  const variable = (n: number) => { const out = [n & 127]; while ((n = Math.floor(n / 128))) out.unshift((n & 127) | 128); return out; };
  const track: number[] = [];
  const microseconds = Math.round(60000000 / score.tempo);
  track.push(0, 255, 81, 3, microseconds >> 16 & 255, microseconds >> 8 & 255, microseconds & 255);
  track.push(0, 255, 88, 4, score.meter[0], Math.log2(score.meter[1]), 24, 8);
  const notes = score.measures.flatMap(m => m.notes);
  const duration = (n: typeof notes[number]) => Math.max(1, Math.round(score.mode === 'free' && n.durationSeconds !== undefined ? n.durationSeconds * PPQ * score.tempo / 60 : ticksOf(n)));
  let rest = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i], pitch = midiOf(n, score.key);
    let ticks = duration(n);
    if (pitch === null) { rest += ticks; continue; }
    if (pitch < 0 || pitch > 127) throw new Error('音高超出 MIDI 范围，请调整八度后导出');
    while (notes[i].tie && i + 1 < notes.length && midiOf(notes[i + 1], score.key) === pitch) ticks += duration(notes[++i]);
    track.push(...variable(rest), 144, pitch, 88, ...variable(ticks), 128, pitch, 0);
    rest = 0;
  }
  track.push(...variable(rest), 255, 47, 0);
  const size = track.length;
  return new Uint8Array([77, 84, 104, 100, 0, 0, 0, 6, 0, 0, 0, 1, PPQ >> 8, PPQ & 255, 77, 84, 114, 107, size >>> 24, size >>> 16 & 255, size >>> 8 & 255, size & 255].concat(track));
}

// Export sounding pitches, preserving durations, rests and valid ties across bars.
export function musicXml(score: Score): string {
  const flat = score.measures.flatMap(m => m.notes);
  const types: Record<number, string> = {1: 'whole', 2: 'half', 4: 'quarter', 8: 'eighth', 16: '16th', 32: '32nd', 64: '64th', 128: '128th'};
  const steps = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
  const alterations = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
  let index = 0;
  const measures = score.measures.map((m, mi) => {
    const attributes = mi === 0 ? `<attributes><divisions>${PPQ}</divisions><key><fifths>0</fifths></key><time>${score.mode === 'free' ? '<senza-misura/>' : `<beats>${score.meter[0]}</beats><beat-type>${score.meter[1]}</beat-type>`}</time><clef><sign>G</sign><line>2</line></clef></attributes><direction><direction-type><words>简谱 1=${xml(score.key)}；${score.mode === 'free' ? '自由节奏，显示时值为近似' : '请对照原曲校订'}</words></direction-type><sound tempo="${score.tempo}"/></direction>` : '';
    const notes = m.notes.map(n => {
      const pitch = midiOf(n, score.key), prev = flat[index - 1], next = flat[index + 1];
      const stop = pitch !== null && prev?.tie && midiOf(prev, score.key) === pitch;
      const start = pitch !== null && n.tie && next && midiOf(next, score.key) === pitch;
      const ties = `${stop ? '<tie type="stop"/>' : ''}${start ? '<tie type="start"/>' : ''}`;
      const pc = pitch === null ? 0 : (pitch % 12 + 12) % 12;
      const tone = pitch === null ? '<rest/>' : `<pitch><step>${steps[pc]}</step>${alterations[pc] ? '<alter>1</alter>' : ''}<octave>${Math.floor(pitch / 12) - 1}</octave></pitch>`;
      const timing = score.mode === 'free' && n.durationSeconds !== undefined ? n.durationSeconds * PPQ * score.tempo / 60 : ticksOf(n);
      const notation = stop || start ? `<notations>${stop ? '<tied type="stop"/>' : ''}${start ? '<tied type="start"/>' : ''}</notations>` : '';
      index++;
      return `<note>${tone}<duration>${Math.max(1, Math.round(timing))}</duration>${ties}<type>${types[n.base]}</type>${'<dot/>'.repeat(n.dots)}${notation}${n.lyric ? `<lyric><text>${xml(n.lyric)}</text></lyric>` : ''}</note>`;
    }).join('');
    return `<measure number="${mi + 1}"${score.mode === 'free' ? ' implicit="yes"' : ''}>${attributes}${notes}${mi === score.measures.length - 1 ? '<barline location="right"><bar-style>light-heavy</bar-style></barline>' : ''}</measure>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>${xml(score.title)}</work-title></work><identification><creator type="composer">${xml(score.composer)}</creator><encoding><software>国韵谱音</software></encoding></identification><part-list><score-part id="P1"><part-name>旋律</part-name></score-part></part-list><part id="P1">${measures}</part></score-partwise>`;
}

export function exportEvidence(work: Work, instruction: string, sourceOffset: number) {
  return JSON.stringify({format: 'guoyun-puyin-review', version: 1, exportedAt: new Date().toISOString(),
    statement: '识别结果为待校订草稿；原始事件是模型输出，clarity 为模型响应值而非校准后的准确率；合成样例不能代表真实录音表现。',
    engine: work.engine, instruction, sourceOffset, score: work.score, original: work.original,
    rawEvents: work.rawEvents || [], review: work.review || [], reviewEngine: work.reviewEngine || 'none',
    modelStatus: work.modelStatus, report: work.report, events: work.events}, null, 2);
}
