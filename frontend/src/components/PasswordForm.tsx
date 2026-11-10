import {useState} from 'react';
import {api, type User} from '../lib/session';

const errText = (e: unknown) => (e instanceof Error ? e.message : '操作失败');

export function PasswordForm({user, onDone, onCancel}: {user: User; onDone: (u: User) => void; onCancel?: () => void}) {
  const [old, setOld] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <section className="card account-card">
      <h2>{user.mustChange ? '首次登录，请设置你自己的密码' : '修改密码'}</h2>
      <p className="muted">账号：{user.username}。新密码至少 12 个字符，不能与原密码相同。修改后其他设备上的登录会失效。</p>
      <form
        onSubmit={async e => {
          e.preventDefault();
          if (next !== again) { setError('两次新密码不一致'); return; }
          setBusy(true); setError('');
          try {
            const r = await api('/api/auth/password', {method: 'POST', body: JSON.stringify({currentPassword: old, newPassword: next})});
            onDone(r.user);
          } catch (err) { setError(errText(err)); } finally { setBusy(false); }
        }}
      >
        <label>当前密码<input required type="password" autoComplete="current-password" value={old} onChange={e => setOld(e.target.value)} /></label>
        <label>新密码<input required minLength={12} maxLength={128} type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} /></label>
        <label>确认新密码<input required type="password" autoComplete="new-password" value={again} onChange={e => setAgain(e.target.value)} /></label>
        {error && <p className="alert error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? '保存中…' : '保存新密码'}</button>
        {onCancel && !user.mustChange && <button type="button" className="secondary" onClick={onCancel}>返回工作台</button>}
      </form>
    </section>
  );
}
