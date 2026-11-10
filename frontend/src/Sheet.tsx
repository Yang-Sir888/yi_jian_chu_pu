import {noteSeconds} from './playback';
import {forwardRef} from 'react';
import {ticksOf,PPQ} from './core/music.mjs';
import type {Score} from './types';
export const Sheet=forwardRef<SVGSVGElement,{score:Score;selection:[number,number]|null;onSelect:(mi:number,ni:number)=>void;playTime?:number}>(
function Sheet({score,selection,onSelect,playTime=-1},ref){
  const title=Array.from(score.title||'未命名作品');
  const titleLines=Array.from({length:Math.ceil(title.length/32)},(_,i)=>title.slice(i*32,(i+1)*32).join(''));
  const titleExtra=(titleLines.length-1)*32;
  const left=60,top=160+titleExtra,rowHeight=135;
  const noteWidth=(n:Score['measures'][number]['notes'][number])=>Math.max(n.base===1?112:n.base===2?68:42,(n.lyric?.length||0)*14+10);
  const desired=score.measures.map(m=>Math.max(220,m.notes.reduce((s,n)=>s+noteWidth(n),0)+38));
  const width=Math.max(1000,...desired.map(w=>w+120));let row=0,usedWidth=0;
  const layout=desired.map(w=>{if(usedWidth&&usedWidth+w>width-120){row++;usedWidth=0;}const box={x:left+usedWidth,y:top+row*rowHeight,w};usedWidth+=w;return box;});
  const height=Math.max(400,top+(row+1)*rowHeight+60);
  let elapsed=0;
  return <svg ref={ref} className="sheet" role="group" aria-label={score.title+'简谱，点击音符或按 Tab 选择后按回车编辑'} viewBox={'0 0 '+width+' '+height} xmlns="http://www.w3.org/2000/svg">
    <rect width={width} height={height} fill="#fdfaf0"/>
    <rect x="18" y="18" width={width-36} height={height-36} fill="none" stroke="#d8c9ab" strokeWidth="1"/>
    <rect x="22" y="22" width={width-44} height={height-44} fill="none" stroke="#e6dcc6" strokeWidth="1"/>
    {titleLines.map((line,i)=><text key={i} x={width/2} y={56+i*32} textAnchor="middle" fill="#2b2419" fontSize="27" fontFamily="serif" fontWeight="600">{line}</text>)}
    <text x={width/2} y={85+titleExtra} textAnchor="middle" fill="#8a7d63" fontSize="12">{score.subtitle||'民族音乐 · 专家校订谱'}</text>
    <text x={left} y={120+titleExtra} fontSize="15" fill="#4a4232">{'1='+score.key+'     '+(score.mode==='free'?'自由节奏':score.meter.join('/')+(score.estimates?.meter?'（暂定）':''))+'     ♩='+score.tempo+(score.estimates?.tempo?'（估计）':'')}</text>
    <text x={width-left} y={120+titleExtra} fontSize="12" textAnchor="end" fill="#8a7d63">{[score.lyricist&&'词：'+score.lyricist,score.composer&&'曲：'+score.composer].filter(Boolean).join('　')}</text>
    {score.measures.map((m,mi)=>{
      const {x,y,w:barWidth}=layout[mi];
      const weights=m.notes.map(n=>Math.max(0.7,ticksOf(n)/PPQ)),sum=Math.max(1,weights.reduce((a,b)=>a+b,0));
      const space=Math.max(0,barWidth-38-m.notes.reduce((s,n)=>s+noteWidth(n),0));
      let used=0,usedNatural=0;
      return <g key={m.id+'-'+mi}>
        <text x={x+4} y={y-23} fontSize="10" fill="#b3a584">{String(mi+1).padStart(2,'0')}</text>
        {m.notes.map((n,ni)=>{
          const natural=noteWidth(n);
          const nx=x+20+usedNatural+(used+weights[ni]/2)/sum*space;used+=weights[ni];usedNatural+=natural;
          const duration=noteSeconds(score,n);
          const playing=playTime>=elapsed&&playTime<elapsed+duration;elapsed+=duration;
          const selected=selection?.[0]===mi&&selection?.[1]===ni;
          const lines=n.base>=8?Math.log2(n.base/4):0;
          return <g key={ni} onClick={()=>onSelect(mi,ni)} role="button" tabIndex={0} aria-label={'第'+(mi+1)+'小节第'+(ni+1)+'音 '+n.pitch}
            onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelect(mi,ni);}}} style={{cursor:'pointer'}}>
            <rect x={nx-15} y={y-35} width="30" height="88" fill="transparent"/>{(selected||playing)&&<rect className="selection-mark" x={nx-16} y={y-22} width="32" height="57" rx="5" fill={playing?'#d9a854':'#efe1bd'}/>}
            {n.accidental&&<text x={nx-16} y={y+4} fontSize="12">{n.accidental==='b'?'♭':'♯'}</text>}
            <text x={nx} y={y+5} textAnchor="middle" fontSize="25" fill={n.review?'#9e3a24':'#3a332a'} fontFamily="Georgia,serif">{n.pitch}</text>
            {Array.from({length:Math.max(0,n.octave)},(_,i)=><circle key={'u'+i} cx={nx} cy={y-25-i*6} r="1.6" fill="#3a332a"/>)}
            {Array.from({length:Math.max(0,-n.octave)},(_,i)=><circle key={'d'+i} cx={nx} cy={y+22+lines*5+i*6} r="1.6" fill="#3a332a"/>)}
            {Array.from({length:lines},(_,i)=><line key={i} x1={nx-9} x2={nx+9} y1={y+14+i*5} y2={y+14+i*5} stroke="#3a332a" strokeWidth="1.5"/>)}
            {n.base<=2&&<text x={nx+22} y={y+5} fontSize="19" fill="#3a332a">{n.base===1?'— — —':'—'}</text>}
            {Array.from({length:n.dots},(_,i)=><circle key={'dot'+i} cx={nx+13+i*6} cy={y-2} r="1.7" fill="#3a332a"/>)}
            {n.tie&&<path d={'M '+(nx-8)+' '+(y-37)+' q 18 -11 36 0'} fill="none" stroke="#6f6253" strokeWidth="1.3"/>}
            {n.exactTicks&&<text x={nx} y={y+74} fontSize="9" textAnchor="middle" fill="#a2937a">精确时值 {n.exactTicks}/960 拍</text>}{n.lyric&&<text x={nx} y={y+58} textAnchor="middle" fontSize="12" fill="#5c5344">{n.lyric}</text>}
          </g>;
        })}
        {score.mode!=='free'&&<line x1={x+barWidth-1} x2={x+barWidth-1} y1={y-15} y2={y+26} stroke="#7a6c55" strokeWidth={mi===score.measures.length-1?3:1}/>}
        {score.mode!=='free'&&mi===score.measures.length-1&&<line x1={x+barWidth-6} x2={x+barWidth-6} y1={y-15} y2={y+26} stroke="#7a6c55"/>}
      </g>;
    })}
    <text x={width/2} y={height-22} textAnchor="middle" fontSize="10" fill="#a2937a">国韵谱音 · 面向民族音乐传承的智能简谱识别与生成平台　｜　请对照原曲核校</text>
  </svg>;
});
export function exportSvg(svg:SVGSVGElement,title:string){
  const copy=svg.cloneNode(true) as SVGSVGElement;
  copy.querySelectorAll('.selection-mark').forEach(el=>el.remove());
  copy.querySelectorAll('[tabindex]').forEach(el=>el.removeAttribute('tabindex'));
  const blob=new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n'+new XMLSerializer().serializeToString(copy)],{type:'image/svg+xml;charset=utf-8'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=(title||'简谱').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').slice(0,100)+'.svg';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
