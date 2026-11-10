import type {Score,Note} from '../src/types';
export const PPQ:number;
export const KEY_NAMES:string[];
export function ticksOf(n:Note):number;
export function midiOf(n:Note,key:string):number|null;
export function newId(prefix?:string):string;
export function updateNote(s:Score,sel:{measureIndex:number;noteIndex:number},patch:Partial<Note>):Score;
export function respellScore(s:Score,key:string):Score;
export function normalizeDotted(s:Score):Score;
export function rebarScore(s:Score,meter:number[]):Score;
export function demoScore():Score;
export function spell(midi:number,tonic:number):Partial<Note>;
export function detectNoiseFixes(s:Score):{measureIndex:number;noteIndex:number;suggestedMidi:number|null;reason:string}[];
export function analyzeSignal(data:Float32Array,sr:number,duration:number,opts:any,title?:string):any;
export function analyzeFromNotes(notes:any[],opts:any,title:string,duration:number,frames:any[],gate:number,pitchEnv?:any[]):any;

export function analyzeFrames(data:Float32Array,sr:number):any;
export function segmentNotes(frames:any[],gate:number,minDur:number):any[];
export function estimateTempo(notes:any[]):any;
