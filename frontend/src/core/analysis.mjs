import { PPQ, KEY_NAMES, ticksOf, midiOf } from './constants.mjs';
import { newId, normalizeDotted } from './score.mjs';
// src/audio/repeat.ts
var MIN_MATCH = 8;
var TOLERANCE = 1;
var MAX_PAIRS = 4;
function density(seg) {
  if (seg.length <= 1) return Infinity;
  return (seg[seg.length - 1].start - seg[0].start) / (seg.length - 1);
}
function detectRepeats(notes) {
  const n2 = notes.length;
  if (n2 < MIN_MATCH * 2) return [];
  const p = notes.map((x) => Math.round(x.midi));
  const D = new Int32Array(n2 * n2);
  const at = (i, j) => i * n2 + j;
  for (let i = 0; i < n2; i += 1) {
    for (let j = 0; j < n2; j += 1) {
      if (Math.abs(p[i] - p[j]) <= TOLERANCE) {
        D[at(i, j)] = (i > 0 && j > 0 ? D[at(i - 1, j - 1)] : 0) + 1;
      }
    }
  }
  const hits = [];
  for (let i = 0; i < n2; i += 1) {
    for (let j = 0; j < n2; j += 1) {
      const L = D[at(i, j)];
      if (L >= MIN_MATCH && Math.abs(i - j) >= L) hits.push({ i, j, len: L });
    }
  }
  hits.sort((a, b) => b.len - a.len);
  const spans = [];
  const overlaps = (lo, hi) => spans.some(([l, h]) => !(hi < l || lo > h));
  const pairs = [];
  for (const h of hits) {
    if (pairs.length >= MAX_PAIRS) break;
    const segA = [h.i - h.len + 1, h.i];
    const segB = [h.j - h.len + 1, h.j];
    const a = segA[0] <= segB[0] ? segA : segB;
    const b = segA[0] <= segB[0] ? segB : segA;
    if (overlaps(a[0], a[1]) || overlaps(b[0], b[1])) continue;
    spans.push(a, b);
    pairs.push({ a, b });
  }
  pairs.sort((x, y) => x.a[0] - y.a[0]);
  return pairs;
}
function fillFromRepeat(notes, a, b, out) {
  const segA = notes.slice(a[0], a[1] + 1);
  const segB = notes.slice(b[0], b[1] + 1);
  if (density(segA) > density(segB)) return;
  const ref = segA;
  const tgt = segB;
  const rs = ref[0].start;
  const re = ref[ref.length - 1].end;
  const ts = tgt[0].start;
  const te = tgt[tgt.length - 1].end;
  const span = te - ts;
  const refSpan = re - rs;
  if (span <= 0 || refSpan <= 0) return;
  const refAvg = refSpan / Math.max(1, ref.length);
  for (let k = 0; k < tgt.length - 1; k += 1) {
    const gapStart = tgt[k].end;
    const gapEnd = tgt[k + 1].start;
    const gap = gapEnd - gapStart;
    if (gap <= refAvg * 1.4) continue;
    const r0 = rs + (gapStart - ts) / span * refSpan;
    const r1 = rs + (gapEnd - ts) / span * refSpan;
    const inside = ref.filter((x) => x.start >= r0 && x.start < r1);
    if (inside.length < 2) continue;
    inside.forEach((x) => {
      const frac = (x.start - rs) / refSpan;
      const abs = ts + frac * span;
      const dur = (x.end - x.start) * (span / refSpan);
      out.push({ start: abs, end: abs + dur, midi: x.midi, clarity: x.clarity });
    });
  }
}
function mergeInserted(notes, inserts) {
  const merged = [...notes, ...inserts].sort((a, b) => a.start - b.start);
  const out = [];
  merged.forEach((n2) => {
    const prev = out[out.length - 1];
    if (prev && n2.start - prev.start < 0.05 && Math.abs(n2.midi - prev.midi) <= 1) {
      if (n2.end - n2.start > prev.end - prev.start) {
        prev.end = n2.end;
        prev.midi = n2.midi;
      }
      return;
    }
    out.push({ ...n2 });
  });
  return out;
}
function applyRepeatCorrection(notes) {
  if (notes.length < MIN_MATCH * 2) return notes;
  const pairs = detectRepeats(notes);
  if (pairs.length === 0) return notes;
  const inserts = [];
  for (const { a, b } of pairs) fillFromRepeat(notes, a, b, inserts);
  if (inserts.length === 0) return notes;
  return mergeInserted(notes, inserts);
}

// src/audio/analyze.ts
var MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
var SCALE = [0, 2, 4, 5, 7, 9, 11];
function yin(buf, sr) {
  const W = buf.length;
  const tauMin = Math.max(2, Math.floor(sr / 1e3));
  const tauMax = Math.min(Math.floor(sr / 70), W >> 1);
  const inner = W - tauMax;
  const d = new Float32Array(tauMax + 2);
  for (let tau2 = tauMin; tau2 <= tauMax; tau2 += 1) {
    let sum = 0;
    for (let j = 0; j < inner; j += 1) {
      const diff = buf[j] - buf[j + tau2];
      sum += diff * diff;
    }
    d[tau2] = sum;
  }
  let running = 0;
  for (let tau2 = tauMin; tau2 <= tauMax; tau2 += 1) {
    running += d[tau2];
    d[tau2] = running === 0 ? 1 : d[tau2] * (tau2 - tauMin + 1) / running;
  }
  const THRESH = 0.2;
  let pick = -1;
  for (let tau2 = tauMin + 1; tau2 < tauMax; tau2 += 1) {
    if (d[tau2] < THRESH) {
      while (tau2 + 1 < tauMax && d[tau2 + 1] < d[tau2]) tau2 += 1;
      pick = tau2;
      break;
    }
  }
  if (pick < 0) {
    let best = 1;
    for (let tau2 = tauMin + 1; tau2 < tauMax; tau2 += 1) {
      if (d[tau2] < best) {
        best = d[tau2];
        pick = tau2;
      }
    }
    if (pick < 0 || best > 0.55) return { f0: 0, clarity: 0 };
  }
  const pickVal = d[pick];
  const y0 = d[pick - 1] ?? pickVal;
  const y1 = pickVal;
  const y2 = d[pick + 1] ?? pickVal;
  const denom = y0 - 2 * y1 + y2;
  const shift = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
  const tau = pick + Math.max(-0.5, Math.min(0.5, shift));
  return { f0: sr / tau, clarity: Math.max(0, Math.min(1, 1 - pickVal)) };
}
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}
function percentile(values, p) {
  const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}
function analyzeFrames(data, sr) {
  const win = 512;
  const hop = Math.floor(sr * 0.02);
  const count = Math.max(1, Math.floor((data.length - win) / hop));
  const frames = [];
  const rmsList = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const start = i * hop;
    const frame = data.subarray(start, start + win);
    let rms = 0;
    for (let j = 0; j < win; j += 1) rms += frame[j] * frame[j];
    rms = Math.sqrt(rms / win);
    rmsList[i] = rms;
    const { f0, clarity } = yin(frame, sr);
    frames.push({
      t: start / sr,
      f0,
      midi: f0 > 0 ? 69 + 12 * Math.log2(f0 / 440) : 0,
      clarity,
      rms
    });
  }
  const rmsGate = Math.max(4e-3, percentile(rmsList, 0.9) * 0.12);
  return { frames, rmsGate };
}
function segmentNotes(frames, rmsGate, minDur) {
  const hop = 0.02;
  const N = frames.length;
  if (N === 0) return [];
  const sm = new Float32Array(N);
  for (let i = 0; i < N; i += 1) {
    const vals = [];
    for (let k = -3; k <= 3; k += 1) {
      const j = i + k;
      if (j >= 0 && j < N && frames[j].midi > 0) vals.push(frames[j].midi);
    }
    sm[i] = vals.length ? median(vals) : 0;
  }
  const notes = [];
  let cur = null;
  let peak = 0;
  let devLen = 0;
  let devMidis = [];
  let devClars = [];
  let valleyT = -1;
  let valleyRms = Infinity;
  const flush = () => {
    if (cur && cur.end - cur.start >= minDur) {
      notes.push({
        start: cur.start,
        end: cur.end,
        midi: median(cur.midis),
        clarity: median(cur.clar)
      });
    }
    cur = null;
  };
  for (let i = 0; i < N; i += 1) {
    const f = frames[i];
    const m2 = sm[i];
    if (f.rms > peak) peak = f.rms;
    else peak *= 0.995;
    const dip = cur !== null && peak > 1e-6 && f.rms < peak * 0.12;
    const gate = cur !== null ? Math.max(rmsGate * 0.2, peak * 0.01) : rmsGate;
    const clarOk = cur !== null ? f.clarity > 0.3 : f.clarity > 0.5;
    const voiced = !dip && f.f0 > 60 && f.f0 < 1200 && clarOk && f.rms > gate;
    if (!voiced) {
      if (cur && f.t - cur.end >= 0.035) {
        flush();
        peak = 0;
        devLen = 0;
        devMidis = [];
        devClars = [];
      }
      if (f.rms < valleyRms) {
        valleyRms = f.rms;
        valleyT = f.t;
      }
      continue;
    }
    if (!cur) {
      const start = valleyT >= 0 && f.t - valleyT <= 0.06 ? valleyT : f.t;
      cur = { start, end: f.t + hop, midis: [m2], clar: [f.clarity] };
      devLen = 0;
      devMidis = [];
      devClars = [];
      valleyT = -1;
      valleyRms = Infinity;
      continue;
    }
    const ref = median(cur.midis);
    if (m2 <= 0) {
      if (f.t - cur.end >= 0.035) {
        flush();
        peak = 0;
        devLen = 0;
        devMidis = [];
        devClars = [];
      }
      continue;
    }
    if (Math.abs(m2 - ref) <= 0.5) {
      if (devLen > 0) {
        cur.midis.push(...devMidis);
        cur.clar.push(...devClars);
        devMidis = [];
        devClars = [];
        devLen = 0;
      }
      cur.end = f.t + hop;
      cur.midis.push(m2);
      cur.clar.push(f.clarity);
      continue;
    }
    devLen += 1;
    devMidis.push(m2);
    devClars.push(f.clarity);
    if (devLen >= 3 && Math.abs(m2 - median(devMidis)) <= 0.4) {
      const newStart = frames[i - devLen + 1].t;
      flush();
      cur = { start: newStart, end: f.t + hop, midis: [...devMidis], clar: [...devClars] };
      devLen = 0;
      devMidis = [];
      devClars = [];
    }
  }
  flush();
  const merged = [];
  notes.forEach((note) => {
    const prev = merged[merged.length - 1];
    if (prev && note.end - note.start < minDur && note.start - prev.end < 0.03) return;
    if (prev && note.start - prev.end < 0.03 && Math.abs(note.midi - prev.midi) < 0.5) {
      prev.end = note.end;
      prev.midi = (prev.midi + note.midi) / 2;
      return;
    }
    merged.push({ ...note });
  });
  return merged;
}
function estimateTempo(notes) {
  const onsets = notes.map((n2) => n2.start);
  if (onsets.length < 3) return { bpm: 80, phase: 0 };
  const t0 = onsets[0];
  const scores = /* @__PURE__ */ new Map();
  const phases = /* @__PURE__ */ new Map();
  for (let bpm2 = 50; bpm2 <= 190; bpm2 += 1) {
    const grid = 60 / bpm2 / 2;
    let bestScore = -1;
    let bestPhase = 0;
    for (let p = 0; p < 16; p += 1) {
      const phase = p / 16 * grid;
      let score = 0;
      onsets.forEach((t) => {
        const units = (t - t0 - phase) / grid;
        const dist = Math.abs(units - Math.round(units));
        score += Math.exp(-(dist * dist) / (2 * 0.045 * 0.045));
      });
      if (score > bestScore) {
        bestScore = score;
        bestPhase = phase;
      }
    }
    scores.set(bpm2, bestScore);
    phases.set(bpm2, bestPhase);
  }
  const max = Math.max(...scores.values());
  const pool = [...scores.entries()].filter(([, s]) => s >= max * 0.86).map(([bpm2]) => bpm2).sort((a, b) => Math.abs(Math.log2(a / 84)) - Math.abs(Math.log2(b / 84)));
  const bpm = pool[0] ?? 84;
  return { bpm, phase: phases.get(bpm) ?? 0 };
}
function krumhanslTonic(notes) {
  const hist = new Array(12).fill(0);
  notes.forEach((n2) => {
    hist[(Math.round(n2.midi) % 12 + 12) % 12] += n2.end - n2.start;
  });
  let best = { tonic: 0, score: -Infinity };
  for (let tonic = 0; tonic < 12; tonic += 1) {
    let score = 0;
    for (let i = 0; i < 12; i += 1) score += hist[(tonic + i) % 12] * MAJOR_PROFILE[i];
    if (score > best.score) best = { tonic, score };
  }
  return best;
}
function detectKey(notes, forced) {
  if (forced && forced !== "auto" && KEY_NAMES.includes(forced)) {
    return { key: forced, tonic: KEY_NAMES.indexOf(forced) };
  }
  const { tonic } = krumhanslTonic(notes);
  return { key: KEY_NAMES[tonic], tonic };
}
function detectTonicPerNote(notes, forced, segmentSec = 6, confirmSegments = 3, minSegNotes = 8) {
  const n2 = notes.length;
  if (n2 === 0) return [];
  const globalTonic = krumhanslTonic(notes).tonic;
  if (forced && forced !== "auto" && KEY_NAMES.includes(forced)) {
    return new Array(n2).fill(KEY_NAMES.indexOf(forced));
  }
  const lastStart = notes[n2 - 1].start;
  const segCount = Math.max(1, Math.ceil((lastStart + 1e-3) / segmentSec));
  const segTonics = new Array(segCount).fill(globalTonic);
  for (let s = 0; s < segCount; s += 1) {
    const a = s * segmentSec;
    const b = a + segmentSec;
    const seg = [];
    for (const x of notes) {
      if (x.start < a) continue;
      if (x.start >= b) break;
      seg.push(x);
    }
    if (seg.length >= minSegNotes) segTonics[s] = krumhanslTonic(seg).tonic;
  }
  const anchors = new Array(segCount).fill(globalTonic);
  let anchor = globalTonic;
  let run = 0;
  let runTonic = -1;
  for (let s = 0; s < segCount; s += 1) {
    const t = segTonics[s];
    if (t === anchor) {
      run = 0;
      runTonic = -1;
    } else if (t === runTonic) {
      run += 1;
    } else {
      run = 1;
      runTonic = t;
    }
    if (run >= confirmSegments) {
      anchor = runTonic;
      run = 0;
      runTonic = -1;
    }
    anchors[s] = anchor;
  }
  const tonics = new Array(n2).fill(globalTonic);
  for (let i = 0; i < n2; i += 1) {
    const s = Math.min(segCount - 1, Math.floor(notes[i].start / segmentSec));
    tonics[i] = anchors[s];
  }
  return tonics;
}
function spell(midi, tonic) {
  const relative = Math.round(midi) - (60 + tonic);
  const pc = (relative % 12 + 12) % 12;
  let degree = SCALE.indexOf(pc);
  let accidental = "";
  if (degree < 0) {
    if (SCALE.includes(pc - 1)) {
      degree = SCALE.indexOf(pc - 1);
      accidental = "#";
    } else if (SCALE.includes(pc + 1)) {
      degree = SCALE.indexOf((pc + 1) % 12);
      accidental = "b";
    } else {
      degree = 0;
    }
  }
  const semitone = SCALE[degree];
  const baseMidi = 60 + tonic + semitone;
  const octave = Math.round((Math.round(midi) - baseMidi) / 12);
  return { pitch: degree + 1, octave, accidental };
}
function nearestOctave(midi, target) {
  const octaves = Math.round((midi - target) / 12);
  return midi - octaves * 12;
}
function detectNoiseFixes(score) {
  const items = [];
  score.measures.forEach((m2, mi) => {
    m2.notes.forEach((n2, ni) => {
      const midi = midiOf(n2, score.key);
      if (midi === null) return;
      const durSec = ticksOf(n2) / PPQ * (60 / score.tempo);
      items.push({ noteId: n2.id, measureIndex: mi, noteIndex: ni, midi, durSec });
    });
  });
  if (items.length < 2) return [];
  const fixes = [];
  for (let i = 0; i < items.length; i += 1) {
    const cur = items[i];
    const neighborMidis = [];
    for (let k = i - 2; k <= i + 2; k += 1) {
      if (k !== i && k >= 0 && k < items.length) neighborMidis.push(items[k].midi);
    }
    if (!neighborMidis.length) continue;
    const base = median(neighborMidis);
    const gap = Math.abs(cur.midi - base);
    const short = cur.durSec < 0.25;
    if (gap <= 7 || !short) continue;
    const folded = nearestOctave(cur.midi, base);
    if (folded !== cur.midi && Math.abs(folded - base) < Math.abs(cur.midi - base)) {
      fixes.push({
        noteId: cur.noteId,
        measureIndex: cur.measureIndex,
        noteIndex: cur.noteIndex,
        currentMidi: cur.midi,
        suggestedMidi: folded,
        reason: "octave"
      });
    } else {
      fixes.push({
        noteId: cur.noteId,
        measureIndex: cur.measureIndex,
        noteIndex: cur.noteIndex,
        currentMidi: cur.midi,
        suggestedMidi: Math.round(base),
        reason: "outlier"
      });
    }
  }
  return fixes;
}
var NOTATION_CANDIDATES = [];
[1, 2, 4, 8, 16].forEach((base) => {
  [0, 1, 2].forEach((dots) => {
    const ticks = ticksOf({
      id: "",
      pitch: 1,
      octave: 0,
      accidental: "",
      base,
      dots,
      tie: false
    });
    NOTATION_CANDIDATES.push({ base, dots, ticks });
  });
});
function durationToNotation(ticks) {
  let best = NOTATION_CANDIDATES[0];
  let bestErr = Infinity;
  NOTATION_CANDIDATES.forEach((c) => {
    const err = Math.abs(c.ticks - ticks) / Math.max(1, ticks);
    if (err < bestErr - 1e-9 || Math.abs(err - bestErr) < 1e-9 && c.ticks > best.ticks) {
      bestErr = err;
      best = c;
    }
  });
  return { base: best.base, dots: best.dots };
}
function tryExtendLast(measure, extraSixteenths) {
  const last = measure.notes[measure.notes.length - 1];
  if (!last || last.pitch === 0 || extraSixteenths <= 0) return false;
  const merged = ticksOf(last) + extraSixteenths * (PPQ / 4);
  const cand = durationToNotation(merged);
  const candTicks = ticksOf({ ...last, base: cand.base, dots: cand.dots });
  if (cand.dots > 2 || Math.abs(candTicks - merged) / merged >= 0.03) return false;
  last.base = cand.base;
  last.dots = cand.dots;
  return true;
}
function buildScore(raw, bpm, key, tonic, perNoteTonic, title) {
  const sixteenth = 60 / bpm / 4;
  const t0 = raw.length ? raw[0].start : 0;
  const sixteenthPerBar = 16;
  const ticksPerSixteenth = PPQ / 4;
  const quantized = raw.map((n2, i) => ({
    startQ: Math.max(0, Math.round((n2.start - t0) / sixteenth)),
    durQ: Math.max(1, Math.round((n2.end - n2.start) / sixteenth)),
    midi: Math.round(n2.midi),
    clarity: n2.clarity,
    tonic: perNoteTonic[i] ?? tonic
  }));
  const totalQ = Math.max(quantized.reduce((acc, n2) => Math.max(acc, n2.startQ + n2.durQ), 0), 16);
  const barCount = Math.max(1, Math.ceil(totalQ / sixteenthPerBar));
  const measures = [];
  const cursor = new Array(barCount).fill(0);
  const pushRest = (bar, len) => {
    const measure = measures[bar];
    if (!measure) return;
    const ticks = len * ticksPerSixteenth;
    const { base, dots } = durationToNotation(ticks);
    measure.notes.push({
      id: newId("rest"),
      pitch: 0,
      octave: 0,
      accidental: "",
      base,
      dots,
      tie: false
    });
  };
  for (let b = 0; b < barCount; b += 1) {
    measures.push({ id: newId("bar"), notes: [], barline: b === barCount - 1 ? "end" : "single" });
  }
  quantized.forEach((q) => {
    let { startQ, durQ } = q;
    if (startQ >= barCount * sixteenthPerBar) return;
    let bar = Math.floor(startQ / sixteenthPerBar);
    let offset = startQ % sixteenthPerBar;
    while (bar < barCount) {
      const gap = offset - cursor[bar];
      if (gap > 0) {
        if (gap > 2 || !tryExtendLast(measures[bar], gap)) {
          pushRest(bar, gap);
        }
      }
      cursor[bar] = Math.max(cursor[bar], offset);
      const avail = sixteenthPerBar - offset;
      let take = Math.min(durQ, avail);
      let notation = durationToNotation(take * ticksPerSixteenth);
      let takeQ = Math.round(
        ticksOf({
          id: "q",
          pitch: 0,
          octave: 0,
          accidental: "",
          base: notation.base,
          dots: notation.dots,
          tie: false
        }) / ticksPerSixteenth
      );
      if (takeQ > avail) {
        takeQ = avail;
        notation = durationToNotation(takeQ * ticksPerSixteenth);
      }
      take = takeQ;
      const { base, dots } = notation;
      const spelled = spell(q.midi, q.tonic);
      const more = durQ > take;
      const noteObj = {
        id: newId("note"),
        ...spelled,
        base,
        dots,
        tie: more
      };
      measures[bar].notes.push(noteObj);
      cursor[bar] += take;
      durQ -= take;
      if (!more) break;
      bar += 1;
      offset = 0;
      if (bar >= barCount) break;
    }
  });
  const REST_GRID = [16, 12, 8, 4, 2, 1];
  measures.forEach((measure, bar) => {
    const gap = sixteenthPerBar - cursor[bar];
    if (gap <= 0) return;
    const last = measure.notes[measure.notes.length - 1];
    const absorb = (g) => {
      if (!last || last.pitch === 0 || g <= 0) return false;
      const merged = ticksOf(last) + g * ticksPerSixteenth;
      const cand = durationToNotation(merged);
      const candTicks = ticksOf({ ...last, base: cand.base, dots: cand.dots });
      if (cand.dots > 2 || Math.abs(candTicks - merged) / merged >= 0.03) return false;
      last.base = cand.base;
      last.dots = cand.dots;
      return true;
    };
    if (gap <= 2 && absorb(gap)) {
      cursor[bar] = sixteenthPerBar;
      return;
    }
    const rest = REST_GRID.find((r) => r <= gap) ?? gap;
    if (rest !== gap && absorb(gap - rest)) {
      pushRest(bar, rest);
      cursor[bar] = sixteenthPerBar;
      return;
    }
    pushRest(bar, gap);
  });
  const subtitle = `${KEY_NAMES.includes(key) ? `1=${key}` : key} \xB7 \u81EA\u52A8\u8BC6\u522B`;
  return normalizeDotted({
    title,
    subtitle,
    artist: "\u97F3\u9891\u8BC6\u522B",
    key,
    meter: [4, 4],
    tempo: Math.round(bpm),
    measures
  });
}
function bridgeGaps(notes, maxGapSec) {
  if (notes.length === 0) return [];
  const intervals = [];
  for (let i = 1; i < notes.length; i += 1) intervals.push(notes[i].start - notes[i - 1].start);
  const out = [];
  notes.forEach((n2, idx) => {
    const prev = out[out.length - 1];
    if (prev) {
      const gap = n2.start - prev.end;
      if (gap > 0) {
        const nearby = [];
        for (let k = idx - 2; k <= idx + 1; k += 1) {
          if (k >= 0 && k < intervals.length && intervals[k] > 0) nearby.push(intervals[k]);
        }
        const ref = nearby.length ? median(nearby) : gap;
        const threshold = Math.min(2.5, Math.max(maxGapSec, ref * 1.7));
        if (gap < threshold) prev.end = n2.start;
      }
    }
    out.push({ ...n2 });
  });
  return out;
}
function analyzeFromNotes(rawNotes, opts, title, duration, frames, rmsGate, pitchEnv = []) {
  const started = performance.now();
  const { bpm } = estimateTempo(rawNotes);
  const sixteenth = 60 / bpm / 4;
  const maxGap = Math.max(0.4, sixteenth * 4);
  const bridged = bridgeGaps(rawNotes, maxGap);
  const notes = applyRepeatCorrection(bridged);
  const { key, tonic } = detectKey(notes, opts.keyMode);
  const perNoteTonic = detectTonicPerNote(notes, opts.keyMode);
  const score = buildScore(notes, bpm, key, tonic, perNoteTonic, title);
  const clarity = notes.length ? notes.reduce((a, n2) => a + n2.clarity, 0) / notes.length : 0;
  return {
    score,
    frames,
    rawNotes: notes,
    pitchEnv,
    srcOffset: notes[0]?.start ?? 0,
    bpm,
    key,
    clarity,
    duration,
    rmsGate,
    elapsedMs: performance.now() - started
  };
}
function analyzeSignal(data, sr, duration, opts, title = "\u672A\u547D\u540D") {
  const { frames, rmsGate } = analyzeFrames(data, sr);
  const minDur = Math.max(0.01, opts.minNoteMs / 1e3);
  const gate = rmsGate / Math.max(0.4, opts.sensitivity);
  const rawNotes = segmentNotes(frames, gate, minDur);
  return analyzeFromNotes(rawNotes, opts, title, duration, frames, gate);
}


export { analyzeSignal, analyzeFromNotes, analyzeFrames, segmentNotes, estimateTempo, detectNoiseFixes, spell };
