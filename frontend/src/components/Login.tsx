import {useState} from 'react';
import {useSession} from '../lib/session';

const errText = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请重试');

export default function Login() {
  const {signIn} = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await signIn(username.trim(), password);
      setPassword('');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-layout">
      <section className="login-story">
        <div className="brand"><span className="brand-icon">韵</span> 国韵谱音 <small>GUOYUN PUYIN</small></div>
        <div className="story-content">
          <span className="eyebrow">AI ASSISTED MUSIC TRANSCRIPTION</span>
          <h1>以耳审音，<br />以笔存韵。</h1>
          <p>让清唱与独奏，成为可校订、可留存的简谱。<br />保留原始声音，也保留专家的判断。</p>
          <div className="sound-scroll" aria-hidden="true"><span className="sound-caption">声音有迹 · 传承有谱</span><svg viewBox="0 0 520 116"><line x1="0" x2="520" y1="58" y2="58" stroke="currentColor" opacity=".16"/>{Array.from({length: 72}, (_, i) => {const h = 8 + Math.abs(Math.sin(i * .53) * Math.cos(i * .13)) * 74; return <line key={i} x1={6 + i * 7.2} x2={6 + i * 7.2} y1={58 - h / 2} y2={58 + h / 2} stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity={.25 + Math.abs(Math.sin(i * .13)) * .65}/>;})}</svg><div className="scroll-notes">1　2　3　5　6　｜　5　3　2　1</div></div>
        </div>
        <div className="story-footer"><span>本地识别 · 人机协同校订 · 多格式留存</span><span>国韵谱音 / 研究工作台</span></div>
      </section>
      <section className="login-form">
        <div className="login-card">
          <span className="eyebrow">EXPERT WORKSPACE</span>
          <h2>进入专家工作台</h2>
          <p className="muted">使用管理员为你分配的独立账号登录。本平台不开放注册。</p>
          <form onSubmit={submit}>
            <label>专家账号
              <input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required placeholder="请输入账号" />
            </label>
            <label>登录密码
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required placeholder="请输入密码" />
            </label>
            {error && <div className="alert error" role="alert">{error}</div>}
            <button className="primary full" disabled={busy}>{busy ? '登录中…' : '登录工作台 →'}</button>
          </form>
          <p className="login-help">无需填写 API 密钥，由管理员统一配置。无法登录时，请联系项目管理员分配账号或重置密码。</p>
        </div>
      </section>
    </div>
  );
}
