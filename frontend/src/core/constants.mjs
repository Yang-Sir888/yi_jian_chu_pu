// src/score/glyphs.ts
var PPQ = 960;
var DOT_FACTOR = [1, 1.5, 1.75];
function ticksOf(note) {
  if(Number.isFinite(note.exactTicks))return note.exactTicks;
  return 4 / note.base * PPQ * DOT_FACTOR[note.dots];
}
var SEMITONES = [0, 2, 4, 5, 7, 9, 11];
var KEY_NAMES = [
  "C",
  "C#",
  "D",
  "Eb",
  "E",
  "F",
  "F#",
  "G",
  "Ab",
  "A",
  "Bb",
  "B"
];
var KEY_OFFSETS = Object.fromEntries(
  KEY_NAMES.map((k, i) => [k, i])
);
function midiOf(note, key) {
  if (note.pitch === 0) return null;
  const root = KEY_OFFSETS[key] ?? 0;
  const acc = note.accidental === "#" ? 1 : note.accidental === "b" ? -1 : 0;
  return 60 + root + SEMITONES[note.pitch - 1] + acc + note.octave * 12;
}


export { PPQ, KEY_NAMES, KEY_OFFSETS, ticksOf, midiOf };
