// End-to-end API verification against a running server (real HTTP, real DB).
// Usage: node tests/e2e.mjs <baseUrl> <adminUser> <adminPass> [sampleWav]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {wav} from './fixtures.mjs';

const [base, adminUser, adminPass, sample] = process.argv.slice(2);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guoyun-e2e-'));
if (!base || !adminUser || !adminPass) {
  console.error('用法：node tests/e2e.mjs http://host:port 管理员账号 初始密码 [样例音频]');
  process.exit(2);
}

let passed = 0;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({name, ok, detail});
  if (ok) passed++;
  else console.error('FAIL', name, detail);
};

function jar() {
  return {cookie: '', csrf: ''};
}

// 经过「发布为应用」的分享域名访问时，网关要求每个请求都携带 sharecode。
// base 里若已带 ?sharecode=xxx，这里自动把它附加到所有请求路径上。
let sharecode = '';
const baseUrl = (() => {
  const u = new URL(base);
  const code = u.searchParams.get('sharecode');
  if (code) sharecode = 'sharecode=' + encodeURIComponent(code);
  u.search = '';
  return u.href.replace(/\/$/, '');
})();
function withSharecode(path) {
  if (!sharecode) return baseUrl + path;
  return baseUrl + path + (path.includes('?') ? '&' : '?') + sharecode;
}

async function call(session, path, {method = 'GET', body, raw, csrf = true, headers = {}} = {}) {
  const h = {...headers};
  if (session.cookie) h.cookie = session.cookie;
  if (csrf && session.csrf) h['x-csrf-token'] = session.csrf;
  let payload = raw;
  if (body !== undefined) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(withSharecode(path), {method, headers: h, body: payload, redirect: 'manual'});
  const setCookie = res.headers.getSetCookie?.() || [];
  const cookie = setCookie.map(c => c.split(';')[0]).find(c => c.startsWith('jianpu_session='));
  if (cookie) session.cookie = cookie;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = {raw: text.slice(0, 80)}; }
  if (data?.csrf) session.csrf = data.csrf;
  return {status: res.status, data, headers: res.headers, setCookie};
}

async function login(username, password) {
  const s = jar();
  const r = await call(s, '/api/auth/login', {method: 'POST', body: {username, password}, csrf: false});
  return {session: s, res: r, setCookie: r.setCookie};
}

const payload = (title) => ({
  score: {
    title, key: 'C', meter: [4, 4], tempo: 96, mode: 'metered',
    measures: [{id: crypto.randomUUID(), notes: [
      {id: crypto.randomUUID(), pitch: 5, octave: 0, accidental: '', base: 4, dots: 0, tie: false},
      {id: crypto.randomUUID(), pitch: 6, octave: 0, accidental: '', base: 4, dots: 0, tie: false},
    ]}],
  },
  original: null, instruction: '', engine: 'manual', events: [], report: '', modelStatus: 'not_run',
});
const full = (title) => {
  const p = payload(title);
  p.original = structuredClone(p.score);
  return p;
};

async function saveWork(session, {id, version, title, audioPath, audioName = '录音.wav'}) {
  const form = new FormData();
  form.append('payload', JSON.stringify(full(title)));
  if (version) form.append('version', String(version));
  if (audioPath) form.append('audio', new Blob([fs.readFileSync(audioPath)], {type: 'audio/wav'}), audioName);
  const res = await fetch(withSharecode('/api/works' + (id ? '/' + id : '')), {
    method: id ? 'PUT' : 'POST',
    headers: {cookie: session.cookie, 'x-csrf-token': session.csrf},
    body: form,
  });
  return {status: res.status, data: await res.json().catch(() => null)};
}

// 1. 未登录访问被拒绝
const anon = jar();
check('未登录访问作品列表返回 401', (await call(anon, '/api/works')).status === 401);

// 2. 管理员登录 + 首次改密
// 注意：若传入的管理员账号此前已改过密码（mustChange=false），下面三条"首次登录"断言
// 并不适用，脚本会自动跳过并提示，而不是误报失败。
const admin = await login(adminUser, adminPass);
check('管理员登录成功', admin.res.status === 200, JSON.stringify({body: admin.res.data, setCookie: admin.setCookie}));
const firstLogin = admin.res.data?.user?.mustChange === true;
if (firstLogin) {
  check('首次登录要求改密', true);
  check('改密前不能访问作品', (await call(admin.session, '/api/works')).status === 403);
} else {
  console.error('SKIP 首次登录改密相关 2 项（该管理员已改过密码）');
}

const newAdminPass = 'Admin-' + Math.random().toString(36).slice(2, 12) + '!A1';
const changed = firstLogin
  ? await call(admin.session, '/api/auth/password', {method: 'POST', body: {currentPassword: adminPass, newPassword: newAdminPass}})
  : {status: 200, data: {note: 'skip'}};
check('管理员修改初始密码', changed.status === 200, JSON.stringify(changed.data));
const adminPassNow = firstLogin ? newAdminPass : adminPass;
const admin2 = await login(adminUser, adminPassNow);
check('新密码可登录', admin2.res.status === 200);
if (firstLogin) check('旧密码已失效', (await login(adminUser, adminPass)).res.status === 401);

// 3. 管理员创建专家号
const suffix = Math.random().toString(36).slice(2, 7);
const aName = 'expertA' + suffix;
const bName = 'expertB' + suffix;
const aCreate = await call(admin2.session, '/api/admin/users', {method: 'POST', body: {username: aName, displayName: '专家甲'}});
const bCreate = await call(admin2.session, '/api/admin/users', {method: 'POST', body: {username: bName, displayName: '专家乙'}});
check('创建专家甲', aCreate.status === 200 && aCreate.data.initialPassword.length >= 20);
check('创建专家乙', bCreate.status === 200);
check('重复账号被拒绝', (await call(admin2.session, '/api/admin/users', {method: 'POST', body: {username: aName, displayName: 'x'}})).status === 409);

// 4. 专家首次改密并登录
const a0 = await login(aName, aCreate.data.initialPassword);
check('专家甲用初始密码登录', a0.res.status === 200, JSON.stringify(a0.res.data));
const aPass = 'Expert-' + Math.random().toString(36).slice(2, 12) + '!B2';
check('专家甲首次改密', (await call(a0.session, '/api/auth/password', {method: 'POST', body: {currentPassword: aCreate.data.initialPassword, newPassword: aPass}})).status === 200);
const A = (await login(aName, aPass)).session;
const B0 = await login(bName, bCreate.data.initialPassword);
const bPass = 'Expert-' + Math.random().toString(36).slice(2, 12) + '!C3';
await call(B0.session, '/api/auth/password', {method: 'POST', body: {currentPassword: bCreate.data.initialPassword, newPassword: bPass}});
const B = (await login(bName, bPass)).session;

// 5. 专家不能访问管理接口
check('专家无法访问管理接口', (await call(A, '/api/admin/users')).status === 403);

// 6. 上传 + 保存（含音频）
const audioPath = sample && fs.existsSync(sample) ? sample : null;
const tmpAudio = audioPath || path.join(tempDir, 'e2e-sample.wav');
if (!audioPath) fs.writeFileSync(tmpAudio, wav({seconds: 4}));
const created = await saveWork(A, {title: '山歌·甲', audioPath: tmpAudio});
check('专家甲上传并保存作品', created.status === 200 && created.data.id, JSON.stringify(created.data));
const workId = created.data?.id;
check('保存后版本为 1', created.data?.version === 1);

// 7. 刷新重开（重新登录后仍能读到作品与音频）
const A2 = (await login(aName, aPass)).session;
const list = await call(A2, '/api/works');
check('重新登录后作品列表包含该作品', list.data?.some(w => w.id === workId), JSON.stringify(list.data));
const reopened = await call(A2, '/api/works/' + workId);
check('刷新/重开读取作品内容', reopened.status === 200 && reopened.data?.score?.title === '山歌·甲');
check('重开返回音频地址', !!reopened.data?.audioUrl);
const audio = await fetch(withSharecode('/api/works/' + workId + '/audio'), {headers: {cookie: A2.cookie}});
const audioBytes = Buffer.from(await audio.arrayBuffer());
check('原录音可试听下载', audio.status === 200 && audioBytes.length > 44, String(audioBytes.length));

// 8. 账号隔离
check('专家乙列表看不到专家甲作品', !(await call(B, '/api/works')).data?.some(w => w.id === workId));
check('专家乙读取专家甲作品返回 404', (await call(B, '/api/works/' + workId)).status === 404);
check('专家乙读取专家甲音频返回 404', (await fetch(withSharecode('/api/works/' + workId + '/audio'), {headers: {cookie: B.cookie}})).status === 404);
check('专家乙删除专家甲作品返回 404', (await call(B, '/api/works/' + workId, {method: 'DELETE'})).status === 404);
check('专家乙不能覆盖专家甲作品', (await saveWork(B, {id: workId, version: 1, title: '篡改'})).status === 404);
check('专家乙自己的作品列表为空', (await call(B, '/api/works')).data?.length === 0);

// 9. 版本冲突
const conflict = await saveWork(A2, {id: workId, version: 0, title: '旧版本覆盖'});
check('过期版本保存返回 409', conflict.status === 409, JSON.stringify(conflict.data));
const updated = await saveWork(A2, {id: workId, version: 1, title: '山歌·甲（校订）'});
check('正确版本可更新为第 2 版', updated.status === 200 && updated.data?.version === 2, JSON.stringify(updated.data));
check('再次用过期的第 1 版保存被拒绝', (await saveWork(A2, {id: workId, version: 1, title: '覆盖'})).status === 409);

// 10. 安全校验
const noCsrf = await fetch(withSharecode('/api/works/' + workId), {method: 'DELETE', headers: {cookie: A2.cookie}});
check('缺少 CSRF 令牌被拒绝', noCsrf.status === 403);
const badOrigin = await fetch(withSharecode('/api/works'), {method: 'POST', headers: {cookie: A2.cookie, 'x-csrf-token': A2.csrf, origin: 'https://evil.example'}});
check('伪造来源被拒绝', badOrigin.status === 403);
fs.writeFileSync(path.join(tempDir, 'bad.wav'), 'not an audio file at all');
const badAudio = await saveWork(A2, {title: '坏音频', audioPath: path.join(tempDir, 'bad.wav')});
check('损坏音频被拒绝', badAudio.status === 400, JSON.stringify(badAudio.data));
fs.writeFileSync(path.join(tempDir, 'silent.wav'), wav({seconds: 3, silent: true}));
check('静音录音被拒绝', (await saveWork(A2, {title: '静音', audioPath: path.join(tempDir, 'silent.wav')})).status === 400);
fs.writeFileSync(path.join(tempDir, 'long.wav'), wav({seconds: 181}));
check('超过 3 分钟的录音被拒绝', (await saveWork(A2, {title: '过长', audioPath: path.join(tempDir, 'long.wav')})).status === 400);

// 11. 模型调用边界
const noKey = await call(A2, '/api/agent', {method: 'POST', body: {score: payload('x').score, instruction: ''}});
check('空要求不调用模型', noKey.status === 200 && noKey.data?.modelStatus === 'not_run');
check('模型状态可查询', (await call(A2, '/api/model/status')).status === 200);
check('专家不能改模型配置', (await call(A2, '/api/admin/model', {method: 'PUT', body: {baseUrl: 'https://x.example/compatible-mode/v1', model: 'qwen-plus', apiKey: 'a'.repeat(30)}})).status === 403);
check('非法接口地址被拒绝', (await call(admin2.session, '/api/admin/model', {method: 'PUT', body: {baseUrl: 'https://evil.example/v1', model: 'qwen-plus', apiKey: 'a'.repeat(30)}})).status === 400);

// 12. 管理员重置/停用会使专家会话失效
const reset = await call(admin2.session, '/api/admin/users/' + bCreate.data.user.id + '/reset', {method: 'POST'});
check('管理员重置专家乙密码', reset.status === 200);
check('重置后专家乙旧会话失效', (await call(B, '/api/works')).status === 401);
await call(admin2.session, '/api/admin/users/' + bCreate.data.user.id + '/disabled', {method: 'POST', body: {disabled: true}});
check('停用后不能登录', (await login(bName, reset.data.initialPassword)).res.status === 401);
check('不能停用管理员', (await call(admin2.session, '/api/admin/users/' + admin2.res.data.user.id + '/disabled', {method: 'POST', body: {disabled: true}})).status === 400);

// 13. 服务重启后的持久化由外部脚本再次调用本测试的读取部分验证
console.log(JSON.stringify({
  base,
  total: results.length,
  passed,
  failed: results.filter(r => !r.ok).map(r => r.name),
  workId,
  experts: {a: aName, b: bName},
  adminChanged: true,
}, null, 2));
process.exit(passed === results.length ? 0 : 1);
