import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadEnv} from './load-env.mjs';

// 平台托管启动不会注入站点地址等变量，这里补读 backend/.env（已存在的进程环境变量优先）。
// ESM 的业务依赖仍需动态加载，保证读环境发生在读取配置之前。
loadEnv();

const {configFromEnv, validateModelSettings} = await import('./config.mjs');
const {createDb, makeRepository} = await import('./db.mjs');
const {makeStorage} = await import('./storage.mjs');
const {createApp, cleanup} = await import('./app.mjs');
const {configFileFromDb, saveConfigToDb} = await import('./settings.mjs');
const {ensureSchema} = await import('./tables.mjs');

const config = configFromEnv();
const db = createDb();
const repo = makeRepository(db);
const storage = makeStorage(db);

// 云端数据库代理偶发 502 / 超时。以前只要启动时连不上，ensureSchema 抛错就会让
// 整个进程退出（平台表现为"自动重启失败：ECONNREFUSED"），一次网络抖动就导致站点
// 长时间不可用。这里改成：先重试若干次；仍不通也照常起服务（健康检查会显示
// 数据库未就绪），后台继续重试，通了再补做建表与密钥加载。
const sleep = ms => new Promise(r => setTimeout(r, ms));
let dbReady = false;
for (let attempt = 1; attempt <= 5 && !dbReady; attempt++) {
  try {
    await ensureSchema(db);
    dbReady = true;
  } catch (error) {
    console.error(JSON.stringify({event: 'db_init_failed', attempt, message: error?.message}));
    await sleep(3000);
  }
}

// 模型服务密钥保存在数据库设置表里，启动时要读回来，否则管理员填的密钥
// 只在当前进程内存有效，服务一重启就退回"未接通"需要重新填。
if (dbReady) {
  await configFileFromDb(repo, config);
} else {
  console.error(JSON.stringify({event: 'db_unavailable_at_boot'}));
  const retry = setInterval(async () => {
    try {
      await ensureSchema(db);
      await configFileFromDb(repo, config);
      clearInterval(retry);
      dbReady = true;
      console.log(JSON.stringify({event: 'db_recovered'}));
    } catch {
      /* 数据库仍不可用，等下一轮 */
    }
  }, 30000);
  retry.unref();
}

const app = createApp({
  repo,
  storage,
  config,
  db,
  saveSettings: settings => saveConfigToDb(repo, settings, config),
  validateModelSettings,
});

const server = app.listen(config.port, config.host, () => {
  console.log(`国韵谱音已启动，监听端口 ${config.port}，站点地址 ${config.origin}，数据存储：${db.kind === 'proxy' ? '云数据库（TCB PostgreSQL）' : db.kind === 'embedded' ? 'PGlite（本地持久化）' : 'PostgreSQL'}`);
});

const timer = setInterval(() => cleanup(repo, storage).catch(() => console.error(JSON.stringify({event: 'cleanup_error'}))), 60000);
timer.unref();

// 沙箱/终端会话结束时平台会发送 SIGHUP，默认动作会直接终止进程（表现为静默 exit 0）。
// 服务应由平台托管长期运行，因此忽略 SIGHUP，只在明确的 SIGINT/SIGTERM 下优雅退出。
process.on('SIGHUP', () => {
  console.log(JSON.stringify({event: 'sighup_ignored'}));
});

// An uncaught exception may leave shared state inconsistent. Stop accepting
// requests and let the deployment supervisor restart a clean process.
process.on('uncaughtException', error => {
  console.error(JSON.stringify({event: 'uncaught_exception', message: error?.message}));
  server.close();
  repo.close().finally(() => process.exit(1));
  setTimeout(() => process.exit(1), 5000).unref();
});
process.on('unhandledRejection', reason => {
  console.error(JSON.stringify({event: 'unhandled_rejection', message: reason?.message || String(reason)}));
  server.close();
  repo.close().finally(() => process.exit(1));
  setTimeout(() => process.exit(1), 5000).unref();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    clearInterval(timer);
    server.close(() => { repo.close().then(() => process.exit(0), () => process.exit(1)); });
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
