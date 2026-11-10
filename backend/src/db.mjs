// 云数据库访问层。
//
// 同一份仓储代码要在两种运行环境里工作：
//   1. 本地 / 自建：有 DATABASE_URL，直接用 pg 连接池。
//   2. 云沙箱：平台不发放连接串，只提供 http://tcb-env.auth-proxy.local/pg/query
//      这个「单条语句」通道（不能开跨语句事务、WAF 会拦部分明文 SQL）。
//
// 因此这里把两边统一成同一个最小接口 `db.query(text, params) -> {rows, rowCount}`：
//   - 单条语句（含参数）两边都走同一条路径，参数用字面量安全拼接后交给数据库。
//   - 需要原子性的写操作，云端改调 lingpu_* 存储函数（见 backend/sql/rpc.sql），
//     函数体在数据库内开事务并做乐观版本校验；本地则用真实事务执行等价逻辑。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {embeddedPool} from './embedded-db.mjs';
import {statements} from './sql.mjs';

const {Pool, types} = pg;

types.setTypeParser(20, v => Number(v)); // int8 -> number（计数、octet_length）
types.setTypeParser(114, v => (v ? JSON.parse(v) : null)); // jsonb
types.setTypeParser(3802, v => (v ? JSON.parse(v) : null));

const PROXY = 'http://tcb-env.auth-proxy.local/pg/query';

// 部署环境里是否存在 TCB 云端环境标记（只有环境 ID，不含任何连接串或密码）
function cloudEnvConfigured() {
  try {
    const text = fs.readFileSync('/workspace/.env.tcb', 'utf-8');
    return /^\s*CLOUDBASE_ENV_ID\s*=\s*\S+/m.test(text);
  } catch {
    return false;
  }
}

// 本地/自建模式的连接串。仅在显式提供时使用，绝不从云环境标记文件里推断。
export function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  return '';
}

// 云端优先：只要部署环境配置了 TCB 环境，就走云数据库通道；
// 只有显式设置 TCB_PG_PROXY=0 或提供 DATABASE_URL 时才退回本地连接池。
function proxyAvailable() {
  if (process.env.TCB_PG_PROXY === '0') return false;
  return Boolean(process.env.TCB_PG_PROXY === '1' || cloudEnvConfigured());
}

// 云端没有连接串，只有平台代理通道
export const CLOUD = 'cloud';

// ---- 参数 -> SQL 字面量 ------------------------------------------------------
// 云通道只接受整条 SQL，没有绑定变量；所有值都经此转义，禁止拼接未转义输入。
function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return `'${value.toISOString()}'::timestamptz`;
  if (Buffer.isBuffer(value)) return `'\\x${value.toString('hex')}'::bytea`;
  if (Array.isArray(value)) return `ARRAY[${value.map(literal).join(',')}]`;
  if (typeof value === 'object') return `${literal(JSON.stringify(value))}::jsonb`;
  // 字符串：单引号翻倍 + 反斜杠转义，且拒绝 NUL（PostgreSQL 文本不接受）
  const text = String(value).replace(/\u0000/g, '');
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function bind(text, params = []) {
  let index = 0;
  return text.replace(/\$(\d+)/g, (_, n) => {
    const value = params[Number(n) - 1];
    index += 1;
    return literal(value);
  }) + (index === 0 && params.length ? '' : '');
}

// ---- 云通道 ----------------------------------------------------------------
// 平台代理是本地 HTTP 服务，偶发会断开连接或超时。读操作自动重试；
// 写操作只在「明确没有拿到响应」时重试，避免重复写入。
const RETRYABLE = code => code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT'
  || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_SOCKET' || code === 'ABORT_ERR';

function proxyQuery(text, params, {attempt = 1} = {}) {
  const sqlText = bind(text, params);
  const body = JSON.stringify({sql_b64: Buffer.from(sqlText, 'utf8').toString('base64'), mode: 'write'});
  return fetch(PROXY, {method: 'POST', headers: {'content-type': 'application/json'}, body, signal: AbortSignal.timeout(25000)})
    .then(async res => {
      const raw = await res.text();
      if (!res.ok) throw Object.assign(new Error(`数据库通道 ${res.status}`), {code: 'PROXY'});
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        // WAF 拦截页：说明这条 SQL 触发了平台安全策略
        throw Object.assign(new Error('数据库通道拒绝了该语句'), {code: 'WAF'});
      }
      if (data && !Array.isArray(data) && data.status === 'error') {
        throw Object.assign(new Error(data.message || '数据库执行失败'), {code: 'SQL'});
      }
      if (Array.isArray(data)) return {rows: data, rowCount: data.length};
      return {rows: [], rowCount: 0};
    })
    .catch(error => {
      const transient = RETRYABLE(error?.code) || error?.name === 'TimeoutError' || error?.name === 'AbortError';
      if (transient && attempt < 3) {
        return new Promise(done => setTimeout(done, 120 * attempt))
          .then(() => proxyQuery(text, params, {attempt: attempt + 1}));
      }
      throw error;
    });
}

function proxyDb() {
  const call = (text, params) => proxyQuery(text, params);
  return {
    kind: 'proxy',
    query: call,
    end: async () => {},
    // 单次函数调用即一个事务
    call: async (fn, args) => {
      const placeholders = args.map((_, i) => `$${i + 1}`).join(',');
      const result = await call(`SELECT ${fn}(${placeholders}) AS result`, args);
      return result.rows[0]?.result ?? null;
    },
  };
}

// ---- 本地连接池 ------------------------------------------------------------
function poolDb(connectionString, suppliedPool = null) {
  const pool = suppliedPool || new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX || 6),
    idleTimeoutMillis: 20000,
    connectionTimeoutMillis: 12000,
    ssl: /sslmode=require/.test(connectionString) ? {rejectUnauthorized: false} : undefined,
  });
  pool.on?.('error', () => console.error(JSON.stringify({event: 'pg_pool_error'})));

  const tx = async fn => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* 连接已关闭 */ }
      throw error;
    } finally {
      client.release();
    }
  };

  return {
    kind: suppliedPool ? 'embedded' : 'pool',
    pool,
    query: (text, params) => pool.query(text, params),
    end: () => pool.end(),
    tx,
    // 本地用真实事务复刻云端存储函数的行为，保证两种环境语义一致
    saveWork: async (id, owner, version, payload, audio) => {
      const conflict = () => Object.assign(new Error('作品已被更新，请先导出当前谱面，再重新打开作品。'), {status: 409});
      return tx(async c => {
        const old = id ? (await c.query('SELECT * FROM works WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, owner])).rows[0] : null;
        if (id && !old) return {status: 'missing'};
        if (old && Number(old.version) !== Number(version)) throw conflict();
        const next = old ? Number(old.version) + 1 : 1;
        let saved;
        if (old) {
          saved = (await c.query(
            `UPDATE works SET version=$1, payload=$2, audio_key=COALESCE($3,audio_key), audio_type=COALESCE($4,audio_type),
               audio_name=COALESCE($5,audio_name), updated_at=now() WHERE id=$6 RETURNING id, version`,
            [next, JSON.stringify(payload), audio?.key ?? null, audio?.type ?? null, audio?.name ?? null, old.id])).rows[0];
        } else {
          saved = (await c.query(
            'INSERT INTO works(id,owner_id,version,payload,audio_key,audio_type,audio_name) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id, version',
            [payload.id || (await c.query('SELECT gen_random_uuid() AS id')).rows[0].id, owner, next, JSON.stringify(payload),
              audio?.key ?? null, audio?.type ?? null, audio?.name ?? null])).rows[0];
        }
        if (audio) {
          await c.query('DELETE FROM blob_cleanup WHERE key=$1', [audio.key]);
          if (old?.audio_key && old.audio_key !== audio.key) {
            await c.query('INSERT INTO blob_cleanup(key) VALUES($1) ON CONFLICT DO NOTHING', [old.audio_key]);
          }
        }
        return {status: 'ok', id: saved.id, version: Number(saved.version), audioKey: audio?.key ?? old?.audio_key ?? null};
      });
    },
  };
}

export function createDb() {
  // 云端优先：部署环境配置了 TCB 就走云数据库，不会去连任何旧本地库。
  if (proxyAvailable()) return proxyDb();
  const connectionString = databaseUrl();
  if (connectionString) return poolDb(connectionString);
  const dataDir = path.resolve(process.env.DATA_DIR || fileURLToPath(new URL('../.data', import.meta.url)));
  return poolDb('', embeddedPool(dataDir));
}

export function poolFromEnv() {
  return createDb();
}

// ---- 仓储层 ----------------------------------------------------------------
// 上层只看到「一个用户 / 一份作品」这样的业务语义，不关心底层是连接池还是函数通道。
export function makeRepository(db) {
  const q = (text, params) => db.query(text, params);
  const cloud = db.kind === 'proxy';
  const conflict = () => Object.assign(new Error('作品已被更新，请先导出当前谱面，再重新打开作品。'), {status: 409});

  // 需要原子的写操作：云端走存储函数，本地走事务
  const rpc = async (name, args, local) => {
    if (cloud) return db.call(name, args);
    return local();
  };

  const one = async (text, params) => (await q(text, params)).rows[0];
  const many = async (text, params) => (await q(text, params)).rows;

  return {
    kind: cloud ? CLOUD : 'local',
    ready: async () => Boolean(await one('SELECT 1 AS ok')),

    userByName: name => one('SELECT * FROM users WHERE username=$1', [name]),
    userById: id => one('SELECT * FROM users WHERE id=$1', [id]),
    users: () => many('SELECT id,username,display_name,is_admin,disabled,must_change,created_at FROM users ORDER BY created_at'),
    adminCount: async () => Number((await one('SELECT count(*) AS n FROM users WHERE is_admin')).n),

    createUser: async u => {
      await q('INSERT INTO users(id,username,display_name,password_hash,is_admin,disabled,must_change) VALUES($1,$2,$3,$4,$5,false,$6)',
        [u.id, u.username, u.display_name, u.password_hash, !!u.is_admin, u.must_change !== false]);
    },

    password: (id, hash, mustChange = false) => rpc('lingpu_set_password', [id, hash, mustChange],
      () => db.tx(async c => {
        await c.query('UPDATE users SET password_hash=$1, must_change=$2 WHERE id=$3', [hash, mustChange, id]);
        await c.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      })),

    disabled: (id, flag) => rpc('lingpu_set_disabled', [id, !!flag],
      () => db.tx(async c => {
        await c.query('UPDATE users SET disabled=$1 WHERE id=$2', [!!flag, id]);
        await c.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      })),

    touchLogin: id => q('UPDATE users SET last_login_at=now() WHERE id=$1', [id]),

    addSession: (hash, user, csrf) => rpc('lingpu_add_session', [hash, user, csrf],
      () => db.tx(async c => {
        await c.query('DELETE FROM sessions WHERE expires_at < now()');
        await c.query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3, now() + interval '8 hours')", [hash, user, csrf]);
      })),

    session: async hash => (cloud
      ? db.call('lingpu_session', [hash])
      : one('SELECT u.*, s.csrf FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at > now() AND u.disabled=false', [hash])),

    dropSession: hash => q('DELETE FROM sessions WHERE token_hash=$1', [hash]),

    listWorks: owner => many(
      `SELECT id, version, payload->'score'->>'title' AS title, payload->>'engine' AS engine, updated_at
       FROM works WHERE owner_id=$1 ORDER BY updated_at DESC LIMIT 200`, [owner]),

    work: (id, owner) => one('SELECT * FROM works WHERE id=$1 AND owner_id=$2', [id, owner]),

    // Let an in-flight upload finish before the background janitor can remove it.
    stage: key => q("INSERT INTO blob_cleanup(key,due_at) VALUES($1,now() + interval '1 hour') ON CONFLICT (key) DO NOTHING", [key]),

    // 乐观版本锁：id 存在但版本不一致 → 409；id 不存在 → 404
    save: async (owner, id, version, payload, audio) => {
      const result = await rpc('lingpu_save_work',
        [id || null, owner, Number(version) || 0, payload, audio?.key ?? null, audio?.type ?? null, audio?.name ?? null],
        () => db.saveWork(id, owner, version, payload, audio));

      if (result.status === 'missing') throw Object.assign(new Error('作品不存在'), {status: 404});
      if (result.status === 'conflict') throw conflict();
      if (!result.audioKey) return {id: result.id, version: Number(result.version), audioUrl: null};
      return {id: result.id, version: Number(result.version), audioUrl: '/api/works/' + result.id + '/audio'};
    },

    remove: async (id, owner) => {
      const result = await rpc('lingpu_delete_work', [id, owner],
        () => db.tx(async c => {
          const w = (await c.query('DELETE FROM works WHERE id=$1 AND owner_id=$2 RETURNING audio_key', [id, owner])).rows[0];
          if (!w) return {status: 'missing'};
          if (w.audio_key) await c.query('INSERT INTO blob_cleanup(key) VALUES($1) ON CONFLICT DO NOTHING', [w.audio_key]);
          return {status: 'ok'};
        }));
      return result.status === 'ok';
    },

    garbage: async () => (cloud
      ? (await db.call('lingpu_garbage', [])) || []
      : (await many(
        `SELECT key FROM blob_cleanup WHERE due_at <= now()
         AND NOT EXISTS (SELECT 1 FROM works WHERE audio_key = blob_cleanup.key) LIMIT 100`)).map(r => r.key)),

    forget: key => q('DELETE FROM blob_cleanup WHERE key=$1', [key]),
    allAudio: async () => (await many('SELECT audio_key AS key FROM works WHERE audio_key IS NOT NULL')).map(r => r.key),
    audioSize: async () => {
      if (cloud) {
        const result = await db.call('lingpu_audio_size', []);
        return Number(result?.bytes || 0);
      }
      return Number((await one('SELECT COALESCE(SUM(octet_length(data)),0) AS n FROM audio_blobs')).n);
    },

    setting: async key => (await one('SELECT value FROM app_settings WHERE key=$1', [key]))?.value,
    setSetting: (key, value) => rpc('lingpu_set_setting', [key, value],
      () => q('INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()', [key, JSON.stringify(value)])),

    // A single conditional UPSERT enforces one shared daily budget across
    // restarts and multiple server instances. Failed upstream calls still count.
    reserveModelCall: async (day, limit) => {
      const result = await q(`INSERT INTO app_settings(key,value) VALUES($1,'{"calls":1}'::jsonb)
        ON CONFLICT (key) DO UPDATE SET
          value=jsonb_build_object('calls',(app_settings.value->>'calls')::integer+1), updated_at=now()
        WHERE (app_settings.value->>'calls')::integer < $2 RETURNING key`, ['model_usage:' + day, limit]);
      return result.rows.length > 0;
    },

    close: () => db.end(),
  };
}
