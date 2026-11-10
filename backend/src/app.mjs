import express from 'express';
import helmet from 'helmet';
import {rateLimit} from 'express-rate-limit';
import multer from 'multer';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {digest, cookieToken, checkPassword, makeSession, publicUser, hashPassword, createUser, randomPassword} from './auth.mjs';
import {assertWork} from '../core/validation.mjs';
import {validateAudio, MAX_BYTES} from './audio.mjs';
import {runAgent, testModelConnection} from './agent.mjs';
import {assertScore} from '../core/validation.mjs';

export function createApp({repo, storage, config, agentRunner = runAgent, connectionTest = testModelConnection, saveSettings = null}) {
  const app = express();
  const dist = fileURLToPath(new URL('../../frontend/dist', import.meta.url));
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'blob:', 'data:'],
        mediaSrc: ["'self'", 'blob:'],
        workerSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginResourcePolicy: {policy: 'same-origin'},
  }));

  app.use('/api', (_q, r, n) => { r.set('Cache-Control', 'no-store'); n(); });
  app.use(express.json({limit: '8mb'}));

  // Only configured origins are trusted. Forwarded headers are controlled by
  // proxies (and sometimes clients), so they must not expand the CSRF allowlist.
  const extraOrigins = String(config.extraOrigins || '')
    .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  app.use('/api', (q, r, n) => {
    if (q.method === 'GET' || q.method === 'HEAD') return n();
    const origin = q.headers.origin;
    if (!origin) return n();
    const expected = new URL(config.origin).origin;
    const normalized = origin.replace(/\/+$/, '');
    if (normalized === expected || extraOrigins.includes(normalized)) return n();
    return r.status(403).json({error: '请从正式网站操作，当前地址与服务配置不一致'});
  });

  const limit = (count, windowMs = 60000) => rateLimit({
    windowMs, limit: count, standardHeaders: 'draft-7', legacyHeaders: false,
    message: {error: '操作过于频繁，请稍后重试'},
  });

  const cookie = {httpOnly: true, sameSite: 'lax', secure: new URL(config.origin).protocol === 'https:', path: '/', maxAge: 8 * 3600000};
  const status = () => ({status: config.modelHealth.status, checkedAt: config.modelHealth.checkedAt, message: config.modelHealth.message});
  const sessionResponse = u => ({user: publicUser(u), modelHealth: status(), localMode: !config.production});

  function issue(q, r, u) {
    const old = cookieToken(q);
    return (async () => {
      if (old) await repo.dropSession(digest(old));
      const s = makeSession(repo, u.id);
      await s.pending;
      r.cookie('jianpu_session', s.token, cookie);
      return {...sessionResponse(u), csrf: s.csrf};
    })();
  }

  app.get('/api/health', async (_q, r) => {
    let db = false;
    try { db = await repo.ready(); } catch { db = false; }
    r.status(db ? 200 : 503).json({ok: db, version: '2.2.0', database: db});
  });

  app.post('/api/auth/login', limit(15, 15 * 60000), async (q, r) => {
    const {username, password} = q.body || {};
    if (typeof username !== 'string' || username.length > 48 || typeof password !== 'string' || password.length > 128) {
      return r.status(400).json({error: '请输入有效账号和密码'});
    }
    const u = await repo.userByName(username.trim().toLowerCase());
    const ok = await checkPassword(password, u?.password_hash || '00000000000000000000000000000000:' + '00'.repeat(64));
    if (!ok || !u || u.disabled) return r.status(401).json({error: '账号或密码不正确，或账号已停用'});
    await repo.touchLogin(u.id).catch(() => {});
    r.json(await issue(q, r, u));
  });

  app.use('/api', async (q, r, n) => {
    try {
      const token = cookieToken(q);
      const u = token && /^[a-f0-9]{64}$/.test(token) ? await repo.session(digest(token)) : null;
      if (!u) return r.status(401).json({error: '请先登录'});
      q.user = u;
      if (q.method !== 'GET' && q.method !== 'HEAD' && q.headers['x-csrf-token'] !== u.csrf) {
        return r.status(403).json({error: '会话校验失败，请刷新页面'});
      }
      if (u.must_change && !['/auth/me', '/auth/password', '/auth/logout'].includes(q.path)) {
        return r.status(403).json({error: '首次登录请先修改密码'});
      }
      n();
    } catch (error) {
      n(error);
    }
  });

  app.get('/api/auth/me', (q, r) => r.json({...sessionResponse(q.user), csrf: q.user.csrf}));
  app.post('/api/auth/logout', async (q, r) => {
    const token = cookieToken(q);
    if (token) await repo.dropSession(digest(token));
    r.clearCookie('jianpu_session', cookie);
    r.json({ok: true});
  });

  app.post('/api/auth/password', limit(6, 15 * 60000), async (q, r) => {
    if (!await checkPassword(q.body?.currentPassword, q.user.password_hash)) return r.status(400).json({error: '当前密码不正确'});
    if (q.body?.newPassword === q.body?.currentPassword) return r.status(400).json({error: '新密码不能与原密码相同'});
    const hash = await hashPassword(q.body?.newPassword);
    await repo.password(q.user.id, hash);
    r.json(await issue(q, r, await repo.userById(q.user.id)));
  });

  app.use('/api/admin', (q, r, n) => (q.user.is_admin ? n() : r.status(403).json({error: '仅管理员可操作'})));

  app.get('/api/admin/users', async (_q, r) => r.json((await repo.users()).map(publicUser)));

  app.post('/api/admin/users', limit(20), async (q, r) => {
    const password = randomPassword();
    const username = String(q.body?.username || '').trim().toLowerCase();
    const id = await createUser(repo, {username, displayName: q.body?.displayName, password});
    r.json({user: publicUser(await repo.userById(id)), initialPassword: password});
  });

  app.post('/api/admin/users/:id/reset', limit(20), async (q, r) => {
    const u = await repo.userById(q.params.id);
    if (!u || u.is_admin) return r.status(400).json({error: '只能重置专家账号；管理员请使用修改密码或服务器恢复工具'});
    const password = randomPassword();
    await repo.password(u.id, await hashPassword(password), true);
    r.json({initialPassword: password});
  });

  app.post('/api/admin/users/:id/disabled', limit(20), async (q, r) => {
    const u = await repo.userById(q.params.id);
    if (!u || u.is_admin || typeof q.body?.disabled !== 'boolean') return r.status(400).json({error: '只能停用或启用专家账号'});
    await repo.disabled(u.id, q.body.disabled);
    r.json({ok: true});
  });

  app.get('/api/admin/model', (_q, r) => r.json({baseUrl: config.llm.baseUrl, model: config.llm.model, keySet: !!config.llm.apiKey, health: status()}));

  app.put('/api/admin/model', limit(10), async (q, r) => {
    const {validateModelSettings} = await import('./config.mjs');
    const next = validateModelSettings(q.body);
    const llm = {...config.llm, ...next};
    if (!llm.apiKey) throw Object.assign(new Error('请填写完整密钥'), {status: 400});
    if (saveSettings) await saveSettings(llm);
    else {
      config.llm = llm;
      config.modelHealth = {status: 'pending', checkedAt: null, message: '配置已保存，尚未验证'};
    }
    r.json({health: status()});
  });

  let active = 0;
  async function withModel(q, r, work) {
    if (work) {
      assertScore(q.body?.score);
      if (typeof q.body?.instruction !== 'string' || q.body.instruction.length > 2000) {
        return r.status(400).json({error: '记谱要求最多 2000 字'});
      }
    }
    if (active >= config.concurrency) return r.status(429).json({error: '智能整理任务繁忙，请稍后重试'});
    active++;
    const controller = new AbortController();
    const close = () => { if (!r.writableEnded) controller.abort(); };
    r.on('close', close);
    try {
      // Empty instructions and unconfigured models do not use paid quota.
      const paidCall = config.llm.apiKey && config.llm.baseUrl && (!work || q.body.instruction.trim());
      if (paidCall) {
        // Use the same UTC day on all replicas; reserve atomically before sending.
        const day = new Date().toISOString().slice(0, 10);
        if (!await repo.reserveModelCall(day, config.maxModelCallsPerDay || 300)) {
          return r.status(429).json({error: '平台今日智能整理调用次数已达上限，明日 UTC 00:00 重置；音频识别与人工校订仍可使用'});
        }
      }
      const result = work
        ? await agentRunner(q.body?.score, q.body?.instruction || '', config.llm, {signal: controller.signal})
        : await connectionTest(config.llm, {signal: controller.signal});
      if (!work || result.modelStatus !== 'not_run') {
        config.modelHealth = {
          status: (work ? result.modelStatus === 'success' : result.ok)
            ? 'success'
            : result.modelStatus === 'unconfigured' ? 'unconfigured' : 'failed',
          checkedAt: new Date().toISOString(),
          message: result.errorMessage || result.report || result.message || '',
        };
      }
      console.log(JSON.stringify({
        event: work ? 'agent' : 'connection_test', userId: q.user.id, status: config.modelHealth.status,
        elapsedMs: result.elapsedMs, usage: result.usage,
      }));
      if (!r.destroyed) r.json({...result, modelHealth: status()});
    } catch (error) {
      if (!r.destroyed) r.status(error.status || 502).json({error: error.message || '模型服务暂时不可用', modelHealth: status()});
    } finally {
      r.off('close', close);
      active--;
    }
  }

  app.post('/api/admin/model/test', limit(3, 60000), (q, r) => withModel(q, r, false));
  const accountModelLimit = rateLimit({
    windowMs: 60000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: q => q.user.id,
    message: {error: '此账号智能整理过于频繁，请稍后重试'},
  });
  app.post('/api/agent', accountModelLimit, (q, r) => withModel(q, r, true));
  app.get('/api/model/status', (_q, r) => r.json(status()));

  app.get('/api/works', async (q, r) => r.json(await repo.listWorks(q.user.id)));

  const idGuard = (q, r, n) => (/^[a-f0-9-]{36}$/.test(q.params.id) ? n() : r.status(404).json({error: '作品不存在'}));

  app.get('/api/works/:id', idGuard, async (q, r) => {
    const w = await repo.work(q.params.id, q.user.id);
    if (!w) return r.status(404).json({error: '作品不存在'});
    const payload = typeof w.payload === 'string' ? JSON.parse(w.payload) : w.payload;
    r.json({id: w.id, version: Number(w.version), ...payload, audioUrl: w.audio_key ? '/api/works/' + w.id + '/audio' : null, audioName: w.audio_name});
  });

  app.get('/api/works/:id/audio', idGuard, async (q, r) => {
    const w = await repo.work(q.params.id, q.user.id);
    if (!w?.audio_key) return r.status(404).json({error: '录音不存在'});
    const data = await storage.get(w.audio_key);
    if (!data) return r.status(404).json({error: '录音不存在'});
    r.set('Content-Type', w.audio_type || 'audio/mpeg');
    r.set('Content-Disposition', 'inline');
    r.set('Accept-Ranges', 'none');
    r.send(data);
  });

  const upload = multer({storage: multer.memoryStorage(), limits: {fileSize: MAX_BYTES, files: 1, fields: 2, fieldSize: 4 * 1024 * 1024}});
  let saving = false;
  const gate = (q, r, n) => {
    if (saving) return r.status(429).json({error: '正在保存其他作品，请稍后重试'});
    saving = true;
    let done = false;
    const release = () => { if (!done) { done = true; saving = false; } };
    r.once('finish', release);
    r.once('close', release);
    n();
  };

  async function save(q, r) {
    let input;
    try { input = JSON.parse(q.body.payload); } catch { throw Object.assign(new Error('作品格式不正确'), {status: 400}); }
    const payload = assertWork(input);
    const id = q.params.id || null;
    const version = Number(q.body.version);
    if (id) {
      const old = await repo.work(id, q.user.id);
      if (!old) return r.status(404).json({error: '作品不存在'});
      if (Number(old.version) !== version) return r.status(409).json({error: '版本冲突，请先导出当前谱面，再重新打开作品'});
    }
    let audio = null;
    if (q.file) {
      const used = await repo.audioSize();
      if (used + q.file.buffer.length > config.maxStorageBytes) {
        throw Object.assign(new Error('私有存储空间已满，请联系管理员清理旧作品'), {status: 507});
      }
      const info = await validateAudio(q.file.buffer);
      const key = q.user.id + '/' + randomUUID();
      await repo.stage(key);
      audio = {key, type: info.type, name: Buffer.from(q.file.originalname, 'latin1').toString('utf8').slice(0, 160)};
      await storage.put(key, q.file.buffer, info.type);
    }
    const saved = await repo.save(q.user.id, id, version, payload, audio);
    r.json(saved);
  }

  app.post('/api/works', limit(30), gate, upload.single('audio'), save);
  app.put('/api/works/:id', idGuard, limit(30), gate, upload.single('audio'), save);

  app.delete('/api/works/:id', idGuard, async (q, r) => {
    if (!await repo.remove(q.params.id, q.user.id)) return r.status(404).json({error: '作品不存在'});
    await cleanup(repo, storage);
    r.json({ok: true});
  });

  app.use('/api', (_q, r) => r.status(404).json({error: '接口不存在'}));

  app.use(express.static(dist, {index: 'index.html', maxAge: '1h'}));
  app.get(/.*/, (_q, r) => r.sendFile(path.join(dist, 'index.html')));

  app.use((err, _q, r, _n) => {
    const s = err.code === 'LIMIT_FILE_SIZE' ? 413 : err.status || (err.code?.startsWith('LIMIT_') ? 400 : 500);
    console.error(JSON.stringify({event: 'request_error', status: s, code: err.code || 'FAILED'}));
    if (r.headersSent) return;
    r.status(s).json({
      error: s >= 500 && s !== 507 ? '服务暂时不可用，请联系管理员'
        : err.code === 'LIMIT_FILE_SIZE' ? '录音超过 20 MB'
          : err.message,
    });
  });

  return app;
}

export async function cleanup(repo, storage) {
  for (const entry of await repo.garbage()) {
    const key = typeof entry === 'string' ? entry : entry.key;
    try { await storage.remove(key); await repo.forget(key); } catch { console.error(JSON.stringify({event: 'audio_cleanup_failed'})); }
  }
}
