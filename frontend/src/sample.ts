// Public-domain synthetic calibration phrase, generated locally without network access.
// This is test input, never a substituted recognition output.
export function createSampleAudio(): File {
  const rate = 22050, lead = .5, beat = .6;
  const pitches = [60, 62, 64, 67, 69, 67, 64, 62, 60];
  const duration = lead + pitches.length * beat + .5;
  const count = Math.ceil(rate * duration);
  const bytes = new ArrayBuffer(44 + count * 2), view = new DataView(bytes);
  const str = (at: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const time = i / rate - lead, index = Math.floor(time / beat), local = time - index * beat;
    let value = 0;
    if (index >= 0 && index < pitches.length && local < beat * .85) {
      const hz = 440 * 2 ** ((pitches[index] - 69) / 12);
      const envelope = Math.min(1, local / .015, (beat * .85 - local) / .035);
      value = .4 * envelope * (Math.sin(2 * Math.PI * hz * local) + .2 * Math.sin(4 * Math.PI * hz * local));
    }
    view.setInt16(44 + i * 2, Math.round(value * 32767), true);
  }
  return new File([bytes], '合成校验样例-123565321-C调100BPM.wav', {type: 'audio/wav'});
}
