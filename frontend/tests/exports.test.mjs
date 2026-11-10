import test from 'node:test';
import assert from 'node:assert/strict';
import {midiBytes, musicXml, exportEvidence} from '../src/exports.ts';
import {createSampleAudio} from '../src/sample.ts';
import {analyzeFrames, segmentNotes} from '../src/core/analysis.mjs';

const note = (pitch, extra = {}) => ({id: 'n', pitch, octave: 0, accidental: '', base: 4, dots: 0, tie: false, ...extra});
const score = (notes, extra = {}) => ({title: '校验 < & "谱>', tempo: 100, key: 'C', meter: [4, 4], measures: [{id: 'bar', notes}], ...extra});

// Parse the actual SMF stream independently, including variable-length delta times.
function parseMidi(bytes) {
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'MThd');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint16(12), 960);
  assert.equal(view.getUint32(18), bytes.length - 22);
  let at = 22, time = 0;
  const events = [];
  const variable = () => { let value = 0, b; do { b = bytes[at++]; value = value * 128 + (b & 127); } while (b & 128); return value; };
  while (at < bytes.length) {
    time += variable(); const status = bytes[at++];
    if (status === 255) { const type = bytes[at++], length = variable(); at += length; if (type === 47) { events.push({end: time}); break; } }
    else { const pitch = bytes[at++], velocity = bytes[at++]; events.push({time, on: status === 144 && velocity > 0, pitch}); }
  }
  return events;
}

test('MIDI preserves tied notes across measures, rests, and key-relative sounding pitch', () => {
  const s = score([], {key: 'D', measures: [{id:'a', notes:[note(1, {tie:true})]}, {id:'b', notes:[note(1), note(0), note(3, {octave:1})]}]});
  assert.deepEqual(parseMidi(midiBytes(s)), [
    {time:0, on:true, pitch:62}, {time:1920, on:false, pitch:62},
    {time:2880, on:true, pitch:78}, {time:3840, on:false, pitch:78}, {end:3840}
  ]);
});

test('MIDI preserves real durations in free mode and final silence', () => {
  const s = score([note(1, {durationSeconds:.3}), note(0, {durationSeconds:.6})], {mode:'free'});
  assert.deepEqual(parseMidi(midiBytes(s)), [{time:0, on:true, pitch:60}, {time:480, on:false, pitch:60}, {end:1440}]);
});

test('MusicXML escapes metadata and represents ties, lyrics, rests, and transposed pitch', () => {
  const s = score([note(1, {tie:true, lyric:'风<&'}), note(1), note(0)], {key:'D'});
  const out = musicXml(s);
  assert.ok(out.includes('校验 &lt; &amp; &quot;谱&gt;'));
  assert.ok(out.includes('<step>D</step><octave>4</octave>'));
  assert.equal((out.match(/<note>/g) || []).length, 3);
  assert.ok(out.includes('<tie type="start"/>'));
  assert.ok(out.includes('<tie type="stop"/>'));
  assert.ok(out.includes('<text>风&lt;&amp;</text>'));
  assert.ok(out.includes('<rest/>'));
});

test('evidence includes original and edited score without secret or audio URL', () => {
  const s = score([note(1)]), w = {score:s, original:s, engine:'demo', events:[], modelStatus:'not_run', report:'', rawEvents:[], audioUrl:'/private/audio', apiKey:'must-not-export'};
  const out = exportEvidence(w, '', 0);
  assert.equal(JSON.parse(out).version, 1);
  assert.ok(!out.includes('/private/audio'));
  assert.ok(!out.includes('must-not-export'));
});

test('synthetic calibration WAV is valid PCM and YIN recovers all nine intended pitches', async () => {
  const file = createSampleAudio(), buffer = await file.arrayBuffer(), view = new DataView(buffer);
  assert.equal(new TextDecoder().decode(new Uint8Array(buffer, 0, 4)), 'RIFF');
  assert.equal(view.getUint32(24, true), 22050);
  const samples = new Float32Array((buffer.byteLength - 44) / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(44 + i * 2, true) / 32768;
  const frames = analyzeFrames(samples, 22050);
  const events = segmentNotes(frames.frames, frames.rmsGate, .025);
  assert.deepEqual(events.map(n => Math.round(n.midi)), [60,62,64,67,69,67,64,62,60]);
});
