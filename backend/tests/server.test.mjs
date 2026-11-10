import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {configFromEnv, validateModelSettings} from '../src/config.mjs';
import {configFileFromDb, saveConfigToDb} from '../src/settings.mjs';
import {testModelConnection} from '../src/agent.mjs';

const baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const fakeKey = 'test-fixture-key-not-a-real-secret';

test('configured origins and model endpoints reject unsafe forms', () => {
  assert.equal(configFromEnv({}).origin, 'http://localhost:3000');
  assert.equal(configFromEnv({}).trustProxy, false);
  assert.throws(() => configFromEnv({APP_ORIGIN:'https://example.com/path'}));
  for (const url of [baseUrl.replace('https:', 'http:'), baseUrl.replace('.com/', '.com:8443/'), 'https://evil.example/compatible-mode/v1', baseUrl+'?x=1']) {
    assert.throws(() => validateModelSettings({baseUrl:url, model:'qwen-plus', apiKey:fakeKey}));
  }
  assert.equal(validateModelSettings({baseUrl, model:'qwen-plus', apiKey:fakeKey}).baseUrl, baseUrl);
});

test('saved model settings survive restart and encrypted keys never leave storage', async () => {
  process.env.MODEL_VAULT_KEY = Buffer.alloc(32, 7).toString('base64');
  let stored;
  const repo = {setSetting:async (_key, value) => {stored=value;}, setting:async () => stored};
  const config = configFromEnv({});
  await saveConfigToDb(repo, {baseUrl, model:'qwen-turbo', apiKey:fakeKey}, config);
  assert.ok(stored.apiKey.startsWith('v1.'));
  assert.ok(!JSON.stringify(stored).includes(fakeKey));
  const restarted = await configFileFromDb(repo, configFromEnv({}));
  assert.equal(restarted.llm.model, 'qwen-turbo');
  assert.equal(restarted.llm.apiKey, fakeKey);
  const envModel = await configFileFromDb(repo, configFromEnv({JIANPU_LLM_MODEL:'qwen-max'}));
  assert.equal(envModel.llm.model, 'qwen-max');
});

test('upstream model requests refuse redirects', async () => {
  let redirect;
  const result = await testModelConnection({baseUrl, model:'test', apiKey:fakeKey}, {fetchImpl:async (_url, options) => {
    redirect = options.redirect;
    return {ok:true, json:async () => ({choices:[{message:{content:'OK'}}]})};
  }});
  assert.equal(result.ok, true);
  assert.equal(redirect, 'error');
});

test('embedded database persists works, isolates transactions and atomically caps shared API quota', async () => {
  const {createDb, makeRepository} = await import('../src/db.mjs');
  const {ensureSchema} = await import('../src/tables.mjs');
  const {makeStorage} = await import('../src/storage.mjs');
  const {createApp, cleanup} = await import('../src/app.mjs');
  const {createUser} = await import('../src/auth.mjs');
  const {demoScore} = await import('../core/music.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guoyun-backend-test-'));
  delete process.env.DATABASE_URL;
  process.env.TCB_PG_PROXY = '0';
  process.env.DATA_DIR = dir;
  let db = createDb();
  let server;
  let stage = 'schema';
  try {
    await ensureSchema(db);
    stage = 'user';
    let repo = makeRepository(db);
    const userId = await createUser(repo, {username:'reviewer', displayName:'评审', password:'test-password-12345', mustChange:false});
    const score = demoScore();
    const payload = {score, original:structuredClone(score), instruction:'', engine:'demo', events:[], report:'', modelStatus:'not_run'};
    const saved = await repo.save(userId, null, 0, payload, null);
    stage = 'quota';
    assert.equal(saved.version, 1);
    // Keep the repository stress fixture separate from today's HTTP budget.
    const calls = await Promise.all(Array.from({length:8}, () => repo.reserveModelCall('2000-01-01', 3)));
    assert.equal(calls.filter(Boolean).length, 3);
    stage = 'rollback';
    await assert.rejects(db.tx(async c => {await c.query("INSERT INTO app_settings(key,value) VALUES('rollback-fixture','{}')"); throw new Error('rollback');}));
    assert.equal((await db.query("SELECT key FROM app_settings WHERE key='rollback-fixture'")).rows.length, 0);
    const storage = makeStorage(db);
    stage = 'audio';
    const key = userId + '/' + crypto.randomUUID();
    await repo.stage(key);
    await storage.put(key, Buffer.from('fixture'), 'audio/wav');
    await cleanup(repo, storage);
    assert.equal((await storage.get(key)).toString(), 'fixture');
    await db.query('UPDATE blob_cleanup SET due_at=now() WHERE key=$1', [key]);
    await cleanup(repo, storage);
    assert.equal(await storage.get(key), null);
    stage = 'http';

    const config = configFromEnv({APP_ORIGIN:'http://localhost:3000'});
    config.llm = {baseUrl, model:'test', apiKey:fakeKey};
    config.maxModelCallsPerDay = 2;
    const app = createApp({repo, storage:makeStorage(db), config, agentRunner:async s => ({score:s, modelStatus:'success', report:'fixture'})});
    server = await new Promise(resolve => {const s=app.listen(0, '127.0.0.1', () => resolve(s));});
    const url = 'http://127.0.0.1:' + server.address().port;
    const login = await fetch(url+'/api/auth/login', {method:'POST', headers:{'content-type':'application/json', origin:config.origin}, body:JSON.stringify({username:'reviewer', password:'test-password-12345'})});
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie');
    assert.ok(!/; Secure/i.test(setCookie));
    const session = await login.json();
    const headers = {'content-type':'application/json', cookie:setCookie.split(';')[0], 'x-csrf-token':session.csrf, origin:config.origin};
    const forged = await fetch(url+'/api/agent', {method:'POST', headers:{...headers, origin:'https://evil.example', 'x-forwarded-host':'evil.example', 'x-forwarded-proto':'https'}, body:JSON.stringify({score, instruction:'速度80'})});
    assert.equal(forged.status, 403);
    const send = () => fetch(url+'/api/agent', {method:'POST', headers, body:JSON.stringify({score, instruction:'速度80'})});
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 429);
    stage = 'restart';
    await new Promise(resolve => server.close(resolve));
    server = null;
    await db.end();
    db = null;
    // A real server restart creates a fresh Node/WASM runtime. Opening a second
    // PGlite instance after closing one in the same runtime is not equivalent.
    const source = `import {createDb,makeRepository} from './src/db.mjs';
      const db=createDb(),repo=makeRepository(db);
      try { console.log(JSON.stringify({version:(await repo.work(process.argv[1],process.argv[2])).version,
        allowed:await repo.reserveModelCall('2000-01-01',3)})); } finally { await db.end(); }`;
    const persisted = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source, saved.id, userId], {
      cwd: path.resolve(import.meta.dirname, '..'), env:{...process.env}, timeout:30000,
    });
    assert.deepEqual(JSON.parse(persisted.stdout), {version:1, allowed:false});
  } catch (error) {
    console.error('Embedded integration failed at:', stage);
    throw error;
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (db) await db.end();
    delete process.env.DATA_DIR;
  }
});
