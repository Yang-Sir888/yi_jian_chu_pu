import React, {useState, useEffect, useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {api, useSession, useSessionState, SessionContext, type ModelHealth} from './lib/session';
import Login from './components/Login';
import Admin from './components/Admin';
import {PasswordForm} from './components/PasswordForm';
import {recognize, validateFile} from './audio';
import {Sheet, exportSvg} from './Sheet';
import {playScore, durationOf} from './playback';
import {download, midiBytes, musicXml, exportEvidence} from './exports';
import {createSampleAudio} from './sample';
import {demoScore, respellScore, rebarScore, updateNote, KEY_NAMES, ticksOf, PPQ} from './core/music.mjs';
import type {Score, Note, Work, WorkItem, Engine, User} from './types';
import './style.css';

const engineNames: Record<Engine, string> = {'basic-pitch': 'Basic Pitch', yin: 'YIN 备用', demo: '示例谱', manual: '人工制谱'};
const blank = (): Score => ({title: '未命名作品', key: 'C', meter: [4, 4], tempo: 96, measures: [{id: crypto.randomUUID(), notes: []}]});
const emptyWork = (score: Score, engine: Engine, instruction = ''): Work => ({score, original: structuredClone(score), engine, instruction, events: [], report: '', modelStatus: 'not_run'});
const message = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请重试');
const clock = (n: number) => Math.floor(n / 60).toString().padStart(2, '0') + ':' + Math.floor(n % 60).toString().padStart(2, '0');

function Studio() {
  const session = useSessionState();
  if (!session.ready) return <div className="loading">国韵谱音 · 正在打开工作台…</div>;
  return (
    <SessionContext.Provider value={session}>
      {session.user ? <Workbench user={session.user} /> : <Login />}
    </SessionContext.Provider>
  );
}

function Workbench({user: currentUser}: {user: User}) {
  const session = useSession();
  const {health, setHealth, setUser, signOut} = session;
  const user = currentUser;
  const [items, setItems] = useState<WorkItem[]>([]);
  const [work, setWork] = useState<Work | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [audioDirty, setAudioDirty] = useState(false);
  const [audioUrl, setAudioUrl] = useState('');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(0);
  const [progressStage, setProgressStage] = useState('准备音频');
  const [fallback, setFallback] = useState(false);
  const [selection, setSelection] = useState<[number, number] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playTime, setPlayTime] = useState(0);
  const [overlay, setOverlay] = useState(false);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState<'studio' | 'admin' | 'password'>('studio');
  const [mode, setMode] = useState<'metered' | 'free'>('metered');
  const [crepe, setCrepe] = useState(false);
  const [undo, setUndo] = useState<Score[]>([]);
  const segmentEnd = useRef<number | null>(null);
  const sheet = useRef<SVGSVGElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const exportMenu = useRef<HTMLDetailsElement>(null);
  const cancel = useRef<AbortController | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  const configured = health.status !== 'unconfigured';
  const score = work?.score;

  const stop = () => {
    segmentEnd.current = null;
    stopRef.current?.();
    stopRef.current = null;
    setPlaying(false);
    setPlayTime(0);
    audio.current?.pause();
  };
  const revoke = () => { if (audioUrl.startsWith('blob:')) URL.revokeObjectURL(audioUrl); };
  const reset = () => {
    setPage('studio'); setUndo([]); stop(); cancel.current?.abort(); revoke();
    setWork(null); setFile(null); setAudioUrl(''); setAudioDirty(false); setDirty(false);
    setSelection(null); setFallback(false); setOffset(0); setInstruction(''); setError(''); setNotice('');
  };
  const loadItems = async () => setItems(await api('/api/works'));

  useEffect(() => {
    if (user && !user.mustChange) void loadItems().catch(e => setError(message(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => { if (dirty || audioDirty || busy) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [dirty, audioDirty, busy]);

  useEffect(() => () => { stopRef.current?.(); cancel.current?.abort(); }, []);

  const allowLeave = () => !(dirty || audioDirty) || window.confirm('当前作品或录音尚未保存，确定离开吗？');

  function chooseFile(f: File) {
    try {
      validateFile(f);
      if (!allowLeave()) return;
      reset();
      setFile(f); setAudioDirty(true); setAudioUrl(URL.createObjectURL(f));
    } catch (e) { setError(message(e)); }
  }

  async function arrange(base: Work) {
    setBusy('智能整理中');
    const result = await api('/api/agent', {
      method: 'POST',
      signal: cancel.current?.signal,
      body: JSON.stringify({score: base.score, instruction: base.instruction}),
    });
    if (result.modelHealth) setHealth(result.modelHealth);
    setUndo(h => [...h, structuredClone(base.score)].slice(-40));
    const next = {...base, score: result.score, events: [...base.events, ...result.events].slice(-300), report: result.report, modelStatus: result.modelStatus};
    setWork(next); setSelection(null); setDirty(true);
    if (result.modelStatus !== 'success') setNotice(result.report);
    return next;
  }

  async function analyze(engine: Engine = 'basic-pitch') {
    if (!file) return;
    stop(); setError(''); setNotice(''); setProgress(0); setProgressStage('解码与检查音频'); setFallback(false);
    const controller = new AbortController();
    cancel.current = controller;
    setBusy('识别旋律中');
    let recognized = false;
    try {
      const result = await recognize(file, engine, setProgress, controller.signal, {reviewWithCrepe: crepe, mode, onStage: setProgressStage});
      recognized = true;
      const base = emptyWork(result.score, engine, instruction);
      base.rawEvents = result.rawEvents;
      base.review = result.review;
      base.reviewEngine = result.reviewEngine;
      base.sourceOffset = result.offset;
      base.events = [{kind: 'stage', text: '使用 ' + engineNames[engine] + ' 识别 ' + file.name}];
      setWork(base); setOffset(result.offset); setDirty(true); setSelection(null);
      if (instruction.trim()) await arrange(base);
      else setNotice('识别草稿已生成。请先试听、校订，再保存或导出；可按需填写记谱要求使用智能整理。');
    } catch (e) {
      setError(message(e));
      if (engine === 'basic-pitch' && !recognized && !controller.signal.aborted) setFallback(true);
    } finally {
      setBusy(''); cancel.current = null;
    }
  }

  function editScore(next: Score) {
    if (!work) return;
    stop();
    setUndo(h => [...h, structuredClone(work.score)].slice(-40));
    setWork({...work, score: next});
    setDirty(true);
    setNotice('');
  }
  function patchNote(patch: Partial<Note>) {
    if (!score || !selection) return;
    editScore(updateNote(score, {measureIndex: selection[0], noteIndex: selection[1]}, patch));
  }

  async function save() {
    if (!work) return;
    setBusy('保存作品中'); setError(''); setNotice('');
    try {
      const data = new FormData();
      data.append('payload', JSON.stringify({...work, instruction, sourceOffset: offset}));
      if (work.version) data.append('version', String(work.version));
      if (file && audioDirty) data.append('audio', file);
      const saved = await api('/api/works' + (work.id ? '/' + work.id : ''), {method: work.id ? 'PUT' : 'POST', body: data});
      setWork({...work, instruction, id: saved.id, version: saved.version, audioUrl: saved.audioUrl ? saved.audioUrl + '?v=' + saved.version : work.audioUrl});
      if (saved.audioUrl) { revoke(); setAudioUrl(saved.audioUrl + '?v=' + saved.version); }
      setAudioDirty(false); setDirty(false);
      setNotice('已保存，可在“我的作品”中继续处理。');
      await loadItems();
    } catch (e) { setError(message(e)); } finally { setBusy(''); }
  }

  async function open(item: WorkItem) {
    if (!allowLeave()) return;
    setBusy('打开作品中'); setError('');
    try {
      const data = await api('/api/works/' + item.id);
      reset();
      setWork(data);
      setInstruction(data.instruction || '');
      setAudioUrl(data.audioUrl ? data.audioUrl + '?v=' + data.version : '');
      setOffset(data.sourceOffset || 0);
    } catch (e) { setError(message(e)); } finally { setBusy(''); }
  }

  async function remove(item: WorkItem) {
    if (!window.confirm('删除“' + (item.title || '未命名作品') + '”及其原录音？此操作无法恢复。')) return;
    if (work?.id === item.id && !allowLeave()) return;
    setBusy('删除中'); setError('');
    try {
      await api('/api/works/' + item.id, {method: 'DELETE'});
      if (work?.id === item.id) reset();
      await loadItems();
    } catch (e) { setError(message(e)); } finally { setBusy(''); }
  }

  async function play() {
    if (playing) { stop(); return; }
    if (!score) return;
    try {
      setPlaying(true);
      stopRef.current = await playScore(score, setPlayTime, () => setPlaying(false), overlay ? audio.current : null, offset, work?.original.tempo);
    } catch (e) { setPlaying(false); setError(message(e)); }
  }

  if (user.mustChange) return <main><PasswordForm user={user} onDone={u => setUser(u)} /></main>;

  const selected = score && selection ? score.measures[selection[0]]?.notes[selection[1]] : null;
  const suspects = score
    ? score.measures.flatMap((m, mi) => m.notes.map((n, ni) => ({measureIndex: mi, noteIndex: ni, review: n.review}))).filter(n => n.review)
    : [];
  const noteCount = score?.measures.reduce((n, m) => n + m.notes.filter(x => x.pitch !== 0).length, 0) || 0;
  function exportWork(format: string) {
    if (!work || !score) return;
    try {
      if (format === 'svg' && sheet.current) exportSvg(sheet.current, score.title);
      if (format === 'musicxml') download(musicXml(score), score.title, 'musicxml', 'application/vnd.recordare.musicxml+xml');
      if (format === 'mid') download(midiBytes(score) as BlobPart, score.title, 'mid', 'audio/midi');
      if (format === 'json') download(exportEvidence(work, instruction, offset), score.title + '-校订记录', 'json', 'application/json');
      if (exportMenu.current) exportMenu.current.open = false;
      setNotice('已导出。' + (format === 'musicxml' ? '可使用 MuseScore 等专业软件继续编辑；自由节奏的显示时值为近似。' : format === 'json' ? '核验文件包含谱面、模型原始事件与操作记录，不含音频或 API 密钥。' : ''));
    } catch (e) { setError(message(e)); }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand brand-button" onClick={() => { if (allowLeave()) reset(); }} disabled={!!busy}>
          <span className="brand-icon">韵</span><span>国韵谱音<small>GUOYUN PUYIN</small></span>
        </button>
        <button className="primary full new-button" disabled={!!busy} onClick={() => { if (allowLeave()) reset(); }}>＋ 新建出谱任务</button>
        <div className="sidebar-label">我的作品 <span>{items.length.toString().padStart(2, '0')}</span></div>
        <div className="work-list">
          {!items.length && <p className="sidebar-empty">保存的简谱将显示在这里。<br />每一段声音，都有自己的位置。</p>}
          {items.map(item => (
            <div className={'work-row ' + (work?.id === item.id ? 'active' : '')} key={item.id}>
              <button className="work-open" disabled={!!busy} onClick={() => void open(item)}>
                <span className="work-icon">♫</span>
                <span>
                  <strong>{item.title || '未命名作品'}</strong>
                  <small>{new Date(item.updated_at).toLocaleDateString('zh-CN', {timeZone: 'Asia/Shanghai'})} · {engineNames[item.engine as Engine] || '作品'}</small>
                </span>
              </button>
              <button className="delete-icon" title={'删除' + item.title} aria-label={'删除' + item.title} disabled={!!busy} onClick={() => void remove(item)}>×</button>
            </div>
          ))}
        </div>
        <div className="account-nav">
          {user.admin && (
            <button className="secondary" disabled={!!busy} onClick={() => { if (allowLeave()) { stop(); setPage(page === 'admin' ? 'studio' : 'admin'); } }}>
              {page === 'admin' ? '返回工作台' : '账号与模型管理'}
            </button>
          )}
          <button className="text-button" disabled={!!busy} onClick={() => { stop(); setPage('password'); }}>修改我的密码</button>
        </div>
        <div className="sidebar-bottom">
          <div className="user-avatar">{user.displayName.slice(0, 1)}</div>
          <div><strong>{user.displayName}</strong><small>{user.admin ? '管理员' : '专家账号'}</small></div>
          <button className="logout" title="退出登录" disabled={!!busy} onClick={async () => { if (!allowLeave()) return; reset(); await signOut(); }}>↗</button>
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <span>民族音乐研究 <i>/</i> <strong>{work ? '简谱校订' : '一键出谱'}</strong></span>
          <div className="top-status" title={health.status === 'unconfigured' ? '百炼接口尚未接通：识别、编辑、试听、导出均可正常使用；智能整理需管理员在「账号与模型管理」中填写服务端密钥' : undefined}>
            <span className={'status-dot ' + (health.status !== 'success' ? 'offline' : '')} />
            {{unconfigured: '百炼未接通', pending: '模型待验证', success: '模型验证成功', failed: '模型调用失败'}[health.status]}
          </div>
        </header>

        <main>
          {page === 'password' ? (
            <PasswordForm user={user} onDone={u => { setUser(u); setPage('studio'); setNotice('密码已修改'); }} onCancel={() => setPage('studio')} />
          ) : page === 'admin' ? (
            <><h1>平台管理</h1><Admin onHealth={(h: ModelHealth) => setHealth(h)} /></>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">MELODY TO NOTATION</span>
                  <h1>{work ? '把每一个音，校准。' : '把听见的旋律，写成简谱。'}</h1>
                  <p className="muted">{work ? '对照原录音检查音高与节奏，保存属于你的校订版本。' : '为清唱与单件乐器录音，提供从识别到校订的完整工作流。'}</p>
                </div>
                <span className="heading-number">{work ? '02' : '01'}</span>
              </div>

              <div className="workflow" aria-label="出谱流程">
                {['导入录音', '识别草稿', '专家校订', '保存与导出'].map((name, i) => <div className={(work ? i < 3 : i === 0) ? 'current' : ''} key={name}><span>{i + 1}</span>{name}</div>)}
              </div>

              {error && <div className="alert error" role="alert">{error}<button onClick={() => setError('')} aria-label="关闭错误">×</button></div>}
              {notice && <div className="alert notice" role="status">{notice}</div>}
              {!configured && <div className="config-note">本地识别模型已内置。自然语言整理尚未配置，由管理员统一设置后，全体专家即可使用。</div>}

              {!work ? (
                <div className="start-grid">
                  <section className="card upload-card">
                    <div className="section-title"><span className="step-pill">01</span><h2>导入一段声音</h2><span className="chip">MP3 / WAV</span></div>
                    <div className={'dropzone ' + (file ? 'has-file' : '')} aria-busy={!!busy}
                      onDragOver={e => e.preventDefault()}
                      onDrop={e => { e.preventDefault(); if (!busy && e.dataTransfer.files[0]) chooseFile(e.dataTransfer.files[0]); }}>
                      <span className="upload-symbol">{file ? '♫' : '↑'}</span>
                      <h3>{file ? file.name : '把录音拖到这里'}</h3>
                      <p>{file ? (file.size / 1024 / 1024).toFixed(2) + ' MB · 已就绪' : '清唱、独奏，让主旋律清晰可辨'}</p>
                      <button className="secondary" disabled={!!busy} onClick={() => input.current?.click()}>{file ? '更换音频' : '选择音频文件'}</button>
                      <small>每份不超过 20 MB · 最长 3 分钟</small>
                    </div>
                    {audioUrl && <audio ref={audio} controls src={audioUrl} className="source-player" />}
                    <label className="instruction-label">记谱要求 <span>可选 · 由百炼整理调号、拍号与速度</span>
                      <textarea value={instruction} maxLength={2000} disabled={!!busy} onChange={e => setInstruction(e.target.value)}
                        placeholder="例如：这是山歌，记成 4/4，速度 76，调号保持不变。" />
                    </label>
                    <div className="recognition-options">
                      <label>节奏处理
                        <select value={mode} disabled={!!busy} onChange={e => setMode(e.target.value as 'metered' | 'free')}>
                          <option value="metered">按拍整理（拍号、速度待核对）</option>
                          <option value="free">自由节奏（保留实际时长）</option>
                        </select>
                      </label>
                      <label className="overlay-label">
                        <input type="checkbox" checked={crepe} disabled={!!busy} onChange={e => setCrepe(e.target.checked)} />
                        CREPE 轻量实验复核（较慢，只标疑点）
                      </label>
                    </div>
                    <div className="action-line">
                      <button className="primary large" disabled={!file || !!busy} onClick={() => void analyze()}>{busy || '开始一键出谱'} <span>→</span></button>
                      {busy && <button className="text-button" onClick={() => cancel.current?.abort()}>取消识别</button>}
                      <span className="subtle">音频在浏览器内识别</span>
                    </div>
                    {busy && <div className="progress-block" role="status" aria-live="polite"><div className="progress-caption"><span>{progressStage}</span><span>{Math.round(progress * 100)}%</span></div><div className="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={progressStage}><span style={{width: Math.max(3, progress * 100) + '%'}} /></div><small>首次加载模型可能较慢，请保持页面打开。可随时取消。</small></div>}
                    {fallback && (
                      <div className="fallback">
                        <p>Basic Pitch 未完成识别。你可以主动选择备用算法，结果会标记为 YIN。</p>
                        <button className="secondary" onClick={() => void analyze('yin')}>使用 YIN 备用识别</button>
                      </div>
                    )}
                    <p className="privacy-note">录音在浏览器内识别；点击“保存作品”才会上传原音到平台服务器。智能整理仅发送谱面和记谱要求。</p>
                  </section>
                  <aside className="start-aside">
                    <section className="guide-card">
                      <span className="eyebrow">一段旋律，四个步骤</span>
                      <h2>从声音到谱面</h2>
                      {[['听见', '在浏览器中识别音高与时值'], ['整理', '按要求调整调号、拍号与速度'], ['校订', '逐音检查，对照原曲试听'], ['留存', '保存作品，导出 SVG 简谱']].map(([a, b], i) => (
                        <div className="guide-step" key={a}><span>{String(i + 1).padStart(2, '0')}</span><div><strong>{a}</strong><p>{b}</p></div></div>
                      ))}
                    </section>
                    <section className="sample-card">
                      <span className="sample-notes">1　2　3　5　6</span>
                      <h3>先感受一下工作台</h3>
                      <p>合成音频可走完整识别流程；示例谱用于体验编辑，均不代表真实录音识别效果。</p>
                      <button className="secondary full" disabled={!!busy} onClick={() => chooseFile(createSampleAudio())}>载入合成校验音频 ↗</button>
                      <small className="sample-reference">参考：C 调 · 100 BPM<br />1 2 3 5 6 5 3 2 1 · 九个音</small>
                      <button className="text-button" disabled={!!busy} onClick={() => { if (!allowLeave()) return; reset(); setWork(emptyWork(demoScore(), 'demo')); setDirty(true); }}>打开五声示例谱 →</button>
                      <button className="text-button" disabled={!!busy} onClick={() => { if (!allowLeave()) return; reset(); setWork(emptyWork(blank(), 'manual')); setDirty(true); }}>从空白谱开始 →</button>
                    </section>
                    <section className="boundary-card"><h3>适用边界</h3><p>优先使用安静环境下的清唱与单声部独奏。伴奏、合唱、滑音与装饰音会降低稳定性；十二平均律记谱无法完整表达民族音乐中的游移音高。</p><p>输出是待校订草稿。当前尚无足量真实民族音乐测试集支撑准确率结论。</p></section>
                  </aside>
                </div>
              ) : (
                <>
                  <section className="card work-toolbar">
                    <label>作品名称<input aria-label="作品名称" value={score!.title} maxLength={120} disabled={!!busy} onChange={e => editScore({...score!, title: e.target.value})} /></label>
                    <label>调号
                      <select aria-label="调号" value={score!.key} disabled={!!busy}
                        onChange={e => editScore({...respellScore(score!, e.target.value), estimates: {...score!.estimates, key: false}})}>
                        {KEY_NAMES.map((k: string) => <option key={k}>{k}</option>)}
                      </select>
                    </label>
                    <label>拍号
                      <select aria-label="拍号" value={score!.meter.join('/')} disabled={!!busy}
                        onChange={e => { editScore(rebarScore(score!, e.target.value.split('/').map(Number))); setSelection(null); }}>
                        {['2/4', '3/4', '4/4', '6/8'].map(m => <option key={m}>{m}</option>)}
                      </select>
                    </label>
                    <label>速度 ♩=
                      <input aria-label="速度" type="number" min="40" max="200" value={score!.tempo} disabled={!!busy}
                        onChange={e => { const t = Number(e.target.value); if (t >= 40 && t <= 200) editScore({...score!, tempo: Math.round(t), estimates: {...score!.estimates, tempo: false}}); }} />
                    </label>
                    <div className="toolbar-actions">
                      <span className="save-state">{dirty ? '● 未保存' : '✓ 已保存'}</span>
                      <details className="export-menu" ref={exportMenu}><summary aria-disabled={!!busy}>导出作品 ↓</summary><div className="export-options">
                        <button disabled={!!busy} onClick={() => exportWork('svg')}>SVG 矢量简谱<small>印刷与展示</small></button>
                        <button disabled={!!busy} onClick={() => exportWork('musicxml')}>MusicXML 乐谱<small>专业软件继续编辑</small></button>
                        <button disabled={!!busy} onClick={() => exportWork('mid')}>MIDI 旋律<small>试听与编曲</small></button>
                        <button disabled={!!busy} onClick={() => exportWork('json')}>JSON 核验记录<small>原始事件与校订前后谱面</small></button>
                      </div></details>
                      <button className="primary" disabled={!!busy} onClick={() => void save()}>{busy === '保存作品中' ? '保存中…' : '保存作品'}</button>
                    </div>
                  </section>

                  <div className="review-metrics">
                    <div><small>识别来源</small><strong>{engineNames[work.engine]}</strong></div>
                    <div><small>谱面旋律音数</small><strong>{noteCount}<em> 音</em></strong></div>
                    <div><small>自动标记疑点</small><strong>{suspects.length}<em> 处</em></strong></div>
                    <div><small>调性与节拍</small><strong>{score!.estimates?.key || score!.estimates?.meter || score!.estimates?.tempo ? '需专家确认' : '当前人工设定'}</strong></div>
                  </div>

                  <div className="config-note">
                    {score!.mode === 'free'
                      ? '自由节奏：试听使用事件的实际时长，速度数值不改变试听；谱面时值符号仅作近似提示。'
                      : '按拍整理：量化后的谱面与原曲可能存在节奏差异，请分段核对。'}
                    {score!.estimates?.key ? ' 调号暂用 C 作为记谱参照；' : ''}
                    {score!.estimates?.tempo ? ' 速度为估计；' : ''}
                    {score!.estimates?.meter ? ' 拍号暂定，尚未经专家确认。' : ''}
                    {' 自动疑点未覆盖所有错误；没有标记也需要试听核对。'}
                  </div>

                  <div className="editor-grid">
                    <section className="card score-card">
                      <div className="score-top">
                        <button className="secondary" disabled={!!busy || !undo.length} onClick={() => {
                          stop(); setWork({...work, score: undo.at(-1)!}); setUndo(undo.slice(0, -1)); setDirty(true); setSelection(null);
                        }}>撤销</button>
                        <span className="chip">{engineNames[work.engine]}</span>
                        <span>{score!.measures.length} 小节 · {score!.measures.reduce((n, m) => n + m.notes.length, 0)} 音符</span>
                        <button className="text-button" disabled={!!busy} onClick={() => {
                          if (window.confirm('恢复为最初识别的谱面？当前谱面修改将被替换。')) { editScore(structuredClone(work.original)); setSelection(null); }
                        }}>恢复原始谱</button>
                      </div>
                      <div className="sheet-scroll">
                        <Sheet ref={sheet} score={score!} selection={selection}
                          onSelect={(mi, ni) => {
                            if (busy) return;
                            setSelection([mi, ni]);
                            const t = score!.measures[mi].notes[ni].sourceStart;
                            if (t !== undefined && audio.current) { audio.current.pause(); audio.current.currentTime = t; }
                          }}
                          playTime={playing ? playTime : -1} />
                      </div>
                      <div className="playbar">
                        <button className="play-button" disabled={!!busy || !score!.measures.some(m => m.notes.length)} onClick={() => void play()} aria-label={playing ? '停止试听' : '试听简谱'}>{playing ? '■' : '▶'}</button>
                        <strong>{clock(playTime)} <span>/ {clock(durationOf(score!))}</span></strong>
                        <label className="overlay-label">
                          <input type="checkbox" checked={overlay} disabled={!audioUrl || playing} onChange={e => setOverlay(e.target.checked)} />叠加原曲
                        </label>
                        <span className="subtle">点击谱面数字，逐音校订</span>
                      </div>
                      {audioUrl && (
                        <div className="original-audio">
                          <span>原始录音</span>
                          <audio ref={audio} controls src={audioUrl}
                            onTimeUpdate={e => { if (segmentEnd.current !== null && e.currentTarget.currentTime >= segmentEnd.current) { e.currentTarget.pause(); segmentEnd.current = null; } }} />
                        </div>
                      )}
                    </section>

                    <aside className="editor-aside">
                      <section className="card note-editor">
                        <div className="section-title"><span className="step-pill">校</span><h2>音符校订</h2></div>
                        {selected ? (
                          <>
                            {selected.review && <p className="alert notice">{selected.review}</p>}
                            {selected.sourceStart !== undefined && (
                              <button className="secondary" disabled={!audioUrl || !!busy} onClick={() => {
                                stop();
                                if (audio.current) {
                                  audio.current.playbackRate = 1;
                                  audio.current.currentTime = Math.max(0, selected.sourceStart! - .15);
                                  const end = (selected.sourceEnd ?? selected.sourceStart! + .5) + .15;
                                  const a = audio.current;
                                  segmentEnd.current = end;
                                  void a.play().catch(e => setError(message(e)));
                                }
                              }}>试听原音片段 {selected.sourceStart.toFixed(2)} 秒</button>
                            )}
                            <p className="muted">第 {selection![0] + 1} 小节 · 第 {selection![1] + 1} 个音符</p>
                            <div className="pitch-buttons">
                              {[0, 1, 2, 3, 4, 5, 6, 7].map(p => (
                                <button key={p} disabled={!!busy} className={selected.pitch === p ? 'chosen' : ''} onClick={() => patchNote({pitch: p})}>{p}</button>
                              ))}
                            </div>
                            <div className="note-fields">
                              {score!.mode === 'free' && (
                                <label>实际时长（秒）
                                  <input type="number" min=".01" max="180" step=".01" disabled={!!busy} value={selected.durationSeconds ?? 0}
                                    onChange={e => { const d = Number(e.target.value); if (d > 0 && d <= 180) patchNote({durationSeconds: d}); }} />
                                </label>
                              )}
                              <label>八度
                                <select value={selected.octave} disabled={!!busy} onChange={e => patchNote({octave: Number(e.target.value)})}>
                                  {[-3, -2, -1, 0, 1, 2, 3].map(o => <option key={o} value={o}>{o === 0 ? '中音' : o > 0 ? '高 ' + o + ' 八度' : '低 ' + (-o) + ' 八度'}</option>)}
                                </select>
                              </label>
                              <label>时值
                                <select value={selected.base} disabled={!!busy} onChange={e => patchNote({base: Number(e.target.value)})}>
                                  {[1, 2, 4, 8, 16, 32, 64, 128].map(b => <option key={b} value={b}>{b} 分音符</option>)}
                                </select>
                              </label>
                              <label>变化音
                                <select value={selected.accidental} disabled={!!busy} onChange={e => patchNote({accidental: e.target.value})}>
                                  <option value="">无</option><option value="#">升 ♯</option><option value="b">降 ♭</option>
                                </select>
                              </label>
                              <label>附点
                                <select value={selected.dots} disabled={!!busy} onChange={e => patchNote({dots: Number(e.target.value)})}>
                                  {[0, 1, 2].map(d => <option key={d} value={d}>{d === 0 ? '无' : d + ' 个附点'}</option>)}
                                </select>
                              </label>
                              <label>歌词<input value={selected.lyric || ''} maxLength={6} disabled={!!busy} onChange={e => patchNote({lyric: e.target.value})} /></label>
                              <label className="tie-check">
                                <input type="checkbox" checked={selected.tie} disabled={!!busy} onChange={e => patchNote({tie: e.target.checked})} />延音到下一音
                              </label>
                            </div>
                            <button className="danger-text" disabled={!!busy} onClick={() => {
                              const next = structuredClone(score!);
                              next.measures[selection![0]].notes.splice(selection![1], 1);
                              editScore(next); setSelection(null);
                            }}>删除选中音符</button>
                          </>
                        ) : <p className="muted note-hint">在谱面中选择一个数字，<br />编辑音高、八度、时值和歌词。</p>}
                        <div className="insert-actions">
                          <button className="secondary" disabled={!!busy} onClick={() => {
                            const next = structuredClone(score!);
                            const mi = selection?.[0] ?? Math.max(0, next.measures.length - 1);
                            if (!next.measures.length) next.measures.push({id: crypto.randomUUID(), notes: []});
                            const index = selection ? selection[1] + 1 : next.measures[mi].notes.length;
                            next.measures[mi].notes.splice(index, 0, {id: crypto.randomUUID(), pitch: 1, octave: 0, accidental: '', base: 4, dots: 0, tie: false});
                            editScore(next); setSelection([mi, index]);
                          }}>＋ 音符</button>
                          <button className="secondary" disabled={!!busy || score!.measures.length >= 500}
                            onClick={() => editScore({...score!, measures: [...score!.measures, {id: crypto.randomUUID(), notes: []}]})}>＋ 小节</button>
                        </div>
                        {suspects.length > 0 && (
                          <div className="suspect-list">
                            <strong>待核对的音符</strong>
                            {suspects.slice(0, 12).map((s, i) => (
                              <button className="text-button" key={i} onClick={() => setSelection([s.measureIndex, s.noteIndex])}>第 {s.measureIndex + 1} 小节 · 第 {s.noteIndex + 1} 音 ↗</button>
                            ))}
                          </div>
                        )}
                        <div className="bar-check">
                          {score!.mode !== 'free' && score!.measures.map((m, i) => ({i, t: m.notes.reduce((n, x) => n + ticksOf(x), 0)}))
                            .filter(m => m.t > score!.meter[0] * 4 / score!.meter[1] * PPQ).slice(0, 3)
                            .map(m => <small key={m.i}>第 {m.i + 1} 小节时值超过拍号容量，请校订。</small>)}
                        </div>
                      </section>

                      <section className="card agent-card">
                        <div className="section-title"><span className="agent-star">✦</span><h2>智能整理</h2></div>
                        <textarea aria-label="记谱要求" value={instruction} maxLength={2000} disabled={!!busy}
                          onChange={e => { setInstruction(e.target.value); setDirty(true); }} placeholder="输入调号、拍号或速度要求…" />
                        <button className="primary full" disabled={!!busy || !instruction.trim()} onClick={async () => {
                          setError(''); stop();
                          try { await arrange({...work, instruction}); } catch (e) { setError(message(e)); } finally { setBusy(''); }
                        }}>{busy === '智能整理中' ? '正在整理…' : work.modelStatus === 'failed' ? '重试智能整理' : '按要求整理谱面'}</button>
                        <span className={'model-state ' + work.modelStatus}>
                          {work.modelStatus === 'success' ? '模型已完成'
                            : work.modelStatus === 'failed' ? '模型失败 · 可重试'
                              : work.modelStatus === 'unconfigured' ? '模型未配置 · 识别谱已保留' : '未请求模型整理'}
                        </span>
                        {work.report && <p className="agent-report">{work.report}</p>}
                        <details>
                          <summary>执行记录 <span>{work.events.length}</span></summary>
                          <ol className="event-list">{work.events.map((e, i) => <li key={i} className={e.kind}><span />{e.text}</li>)}</ol>
                        </details>
                      </section>
                    </aside>
                  </div>
                </>
              )}
              <footer className="page-footer"><span>国韵谱音 · 面向民族音乐传承的智能简谱识别与生成平台</span><span>识别结果供校订参考 · 专家的判断始终重要</span></footer>
            </>
          )}
        </main>
      </div>

      <input type="file" ref={input} accept=".mp3,.wav,audio/mpeg,audio/wav" hidden
        onChange={e => { const f = e.target.files?.[0]; if (f) chooseFile(f); e.target.value = ''; }} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><Studio /></React.StrictMode>);
