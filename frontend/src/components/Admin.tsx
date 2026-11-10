import {useState, useEffect} from 'react';
import {api, type PublicUser as User, type ModelHealth} from '../lib/session';

const errText = (e: unknown) => (e instanceof Error ? e.message : '操作失败');

export default function Admin({onHealth}: {onHealth: (h: ModelHealth) => void}) {
  const [users, setUsers] = useState<User[]>([]);
  const [name, setName] = useState('');
  const [display, setDisplay] = useState('');
  const [invite, setInvite] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState('');
  const [model, setModel] = useState('qwen-plus');
  const [key, setKey] = useState('');
  const [keySet, setKeySet] = useState(false);
  const [health, setHealth] = useState<ModelHealth>({status: 'unconfigured', checkedAt: null, message: ''});

  const run = async (fn: () => Promise<void>) => {
    setError(''); setNotice(''); setBusy(true);
    try { await fn(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  const refresh = async () => setUsers(await api('/api/admin/users'));

  useEffect(() => {
    void run(async () => {
      await refresh();
      const r = await api('/api/admin/model');
      setUrl(r.baseUrl); setModel(r.model); setKeySet(r.keySet); setHealth(r.health); onHealth(r.health);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const invitation = (u: string, p: string) =>
    '国韵谱音 · 面向民族音乐传承的智能简谱识别与生成平台\n访问地址：' + location.origin + '\n账号：' + u + '\n初始密码：' + p +
    '\n首次登录请修改密码。建议使用电脑 Chrome 或 Edge，上传清唱或单件乐器 MP3/WAV（20 MB、3 分钟以内）。识别结果请对照原曲校订。';

  return (
    <div className="admin-grid">
      {error && <div className="alert error" role="alert">{error}</div>}
      {notice && <div className="alert notice" role="status">{notice}</div>}

      <section className="card account-card">
        <h2>专家账号</h2>
        <p className="muted">每位专家使用独立账号，只能看到自己的作品与原录音。重置或停用后，该账号已登录的会话立即失效。</p>
        <form onSubmit={e => {
          e.preventDefault();
          void run(async () => {
            const r = await api('/api/admin/users', {method: 'POST', body: JSON.stringify({username: name.trim(), displayName: display.trim()})});
            setInvite(invitation(r.user.username, r.initialPassword));
            setName(''); setDisplay('');
            await refresh();
          });
        }}>
          <label>账号（字母、数字、_ . -）<input required minLength={3} maxLength={48} value={name} onChange={e => setName(e.target.value)} /></label>
          <label>专家姓名<input maxLength={80} value={display} onChange={e => setDisplay(e.target.value)} /></label>
          <button className="primary" disabled={busy}>创建账号并生成邀请</button>
        </form>
        {invite && (
          <div className="invitation">
            <strong>初始密码仅在此展示一次，请私下转交专家</strong>
            <textarea aria-label="专家邀请信息" readOnly value={invite} />
            <button className="secondary" onClick={() => void run(async () => {
              await navigator.clipboard.writeText(invite);
              setNotice('邀请信息已复制');
            })}>复制登录信息</button>
            <button className="text-button" onClick={() => setInvite('')}>清除显示</button>
          </div>
        )}
        <div className="user-table">
          {users.map(u => (
            <div className="user-line" key={u.id}>
              <div>
                <strong>{u.displayName}</strong>
                <small>{u.username} · {u.admin ? '管理员' : u.disabled ? '已停用' : u.mustChange ? '待首次改密' : '已启用'}</small>
              </div>
              {!u.admin && (
                <>
                  <button className="secondary" disabled={busy} onClick={() => {
                    if (confirm('重置 ' + u.username + ' 的密码？原密码及已登录会话将失效。'))
                      void run(async () => {
                        const r = await api('/api/admin/users/' + u.id + '/reset', {method: 'POST'});
                        setInvite(invitation(u.username, r.initialPassword));
                        await refresh();
                      });
                  }}>重置密码</button>
                  <button className="text-button" disabled={busy} onClick={() => void run(async () => {
                    await api('/api/admin/users/' + u.id + '/disabled', {method: 'POST', body: JSON.stringify({disabled: !u.disabled})});
                    await refresh();
                  })}>{u.disabled ? '启用' : '停用'}</button>
                </>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="card account-card">
        <h2>百炼智能整理服务</h2>
        <p className="muted">管理员只需在此配置一次，全体专家即可使用，无需另填密钥。从百炼控制台复制 OpenAI 兼容专属 Base URL。密钥通过此表单传给服务端加密保存，保存后不会回传给浏览器。请在 HTTPS 网站配置并运行连接测试。</p>
        <form onSubmit={e => {
          e.preventDefault();
          void run(async () => {
            const r = await api('/api/admin/model', {method: 'PUT', body: JSON.stringify({baseUrl: url.trim(), model: model.trim(), ...(key ? {apiKey: key} : {})})});
            setHealth(r.health); onHealth(r.health); setKey(''); setKeySet(true);
            setNotice('已保存，状态为待验证。请点击小额连接测试。');
          });
        }}>
          <label>OpenAI 兼容 Base URL
            <input required type="url" placeholder="https://你的业务空间.cn-beijing.maas.aliyuncs.com/compatible-mode/v1" value={url} onChange={e => setUrl(e.target.value)} />
          </label>
          <label>模型名称<input required value={model} onChange={e => setModel(e.target.value)} /></label>
          <label>{keySet ? '更换密钥（留空保留已有密钥）' : '完整 API Key'}
            <input required={!keySet} type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} />
          </label>
          <button className="primary" disabled={busy}>保存服务配置</button>
          <button className="secondary" type="button" disabled={busy || !keySet} onClick={() => void run(async () => {
            const r = await api('/api/admin/model/test', {method: 'POST'});
            setHealth(r.modelHealth); onHealth(r.modelHealth); setNotice(r.message || r.modelHealth?.message || '');
          })}>小额连接测试（会产生调用）</button>
        </form>
        <p className={'model-state ' + health.status}>
          {{unconfigured: '尚未配置模型', pending: '配置已保存 · 待验证', success: '连接验证成功', failed: '调用失败，请检查密钥与额度'}[health.status]}
        </p>
        {health.message && <p className="agent-report">{health.message}</p>}
        <p className="muted">百炼理解记谱要求并调整调号、拍号与速度（每次最多 3 步）；音频识别由浏览器内的本地模型完成。共享调用费用由配置密钥的账户承担，建议同时在百炼设置预算和额度提醒。</p>
      </section>
    </div>
  );
}
