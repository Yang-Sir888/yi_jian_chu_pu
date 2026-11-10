import { newId } from './score.mjs';
// src/score/demo.ts
var seq = 0;
var n = (pitch, opts = {}) => ({
  id: `demo-${seq += 1}`,
  pitch,
  octave: 0,
  accidental: "",
  base: 4,
  dots: 0,
  tie: false,
  ...opts
});
var m = (notes, barline = "single") => ({
  id: newId("bar"),
  notes,
  barline
});
function demoScore() {
  seq = 0;
  return {
    title: "\u5C71\u8C23",
    subtitle: "\u5BAB\u5546\u89D2\u5FB5\u7FBD \xB7 \u4E94\u58F0\u793A\u4F8B",
    artist: "",
    lyricist: "",
    composer: "\u6C11\u6B4C\u98CE\u683C",
    key: "C",
    meter: [4, 4],
    tempo: 96,
    measures: [
      m([n(5), n(6), n(1), n(2)]),
      m([n(6), n(5), n(3), n(5)]),
      m([n(3), n(2), n(1), n(2)]),
      m([n(3, { base: 4, dots: 1 }), n(2, { base: 8 }), n(1, { base: 2 })]),
      m([n(5), n(6), n(1), n(2)]),
      m([n(6), n(1), n(6), n(5)]),
      m([n(3), n(5), n(2), n(1)]),
      m([n(2, { base: 4, dots: 1 }), n(1, { base: 8 }), n(1, { base: 2 })], "end")
    ]
  };
}


export { demoScore };
