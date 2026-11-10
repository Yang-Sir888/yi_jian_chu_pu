// Bootstrap admin + trial expert account once, and print the generated passwords
// only into the protected setup artifact (never into logs or the browser).
import fs from 'node:fs';
import path from 'node:path';
import {loadEnv} from '../src/load-env.mjs';
import {createDb, makeRepository} from '../src/db.mjs';
import {createUser, randomPassword} from '../src/auth.mjs';
import {ensureSchema} from '../src/tables.mjs';

loadEnv();

// 初始化凭据默认写入「当前目录下的 .lingpu/」，交付包在任意目录运行都能落盘；
// 需要写到别处时用 SETUP_ARTIFACT 指定绝对路径。
const ARTIFACT = process.env.SETUP_ARTIFACT || path.resolve(process.cwd(), '.lingpu', 'setup-credentials.json');

function record(data) {
  fs.mkdirSync(path.dirname(ARTIFACT), {recursive: true});
  fs.writeFileSync(ARTIFACT, JSON.stringify({...data, createdAt: new Date().toISOString()}, null, 2), {mode: 0o600});
}

const db = createDb();
try {
  await ensureSchema(db);
  const repo = makeRepository(db);
  if (await repo.adminCount()) {
    console.log('已有管理员，保留全部账号、密码及作品。');
    // Do not overwrite the only copy of the initial credentials on a second run.
    if (!fs.existsSync(ARTIFACT)) record({existing: true});
  } else {
    const adminPassword = randomPassword();
    await createUser(repo, {username: 'admin', displayName: '平台管理员', password: adminPassword, admin: true});
    const expertPassword = await ensureExpert(repo);
    record({
      admin: {username: 'admin', initialPassword: adminPassword},
      ...(expertPassword ? {expert: expertPassword} : {}),
      storage: db.kind === 'proxy' ? 'TCB PostgreSQL（云数据库）' : db.kind === 'embedded' ? 'PGlite（本地持久化）' : 'PostgreSQL',
    });
    console.log('管理员与试用专家账号已创建，凭据写入受保护的初始化记录（仅管理者可读）。');
  }
} catch (error) {
  console.error(JSON.stringify({event: 'setup_failed', message: error.message}));
  process.exitCode = 1;
} finally {
  await db.end().catch(() => {});
}

async function ensureExpert(repo) {
  if (await repo.userByName('expert01')) return null;
  const password = randomPassword();
  await createUser(repo, {username: 'expert01', displayName: '试用专家', password});
  return {username: 'expert01', initialPassword: password};
}
