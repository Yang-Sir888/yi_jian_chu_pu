import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {configFromEnv} from '../src/config.mjs';

const execute = promisify(execFile);
const cwd = path.resolve(import.meta.dirname, '..');
const fixtureAdmin = 'fixture-admin-password-123';
const fixtureExpert = 'fixture-expert-password-456';
const fixtureRoot = path.resolve(cwd, 'tmp/bootstrap-tests');
async function fixtureDirectory(prefix) {
  await fs.mkdir(fixtureRoot, {recursive:true});
  return fs.mkdtemp(path.join(fixtureRoot,prefix));
}
async function cleanupFixture(directory) {
  const relative = path.relative(fixtureRoot,path.resolve(directory));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  await fs.rm(directory,{recursive:true,force:true});
}

test('Render public origin is trusted only with the platform marker and preserves explicit overrides', () => {
  const render = {RENDER:'true', RENDER_EXTERNAL_URL:'https://fixture.onrender.com'};
  assert.equal(configFromEnv(render).origin, render.RENDER_EXTERNAL_URL);
  assert.equal(configFromEnv({...render, APP_ORIGIN:'https://custom.example'}).origin, 'https://custom.example');
  assert.equal(configFromEnv({...render, RENDER:'false'}).origin, 'http://localhost:3000');
  for (const value of ['https://fixture.onrender.com/path', 'https://user:pass@fixture.onrender.com', 'https://fixture.onrender.com/?x=1']) {
    assert.throws(() => configFromEnv({...render, RENDER_EXTERNAL_URL:value}));
  }
});

// Every setup and inspection is a distinct process, matching an actual service
// restart instead of closing/reopening PGlite's WASM runtime in one process.
test('bootstrap secrets create review accounts once, remain private, and never reset existing users', async () => {
  const directory = await fixtureDirectory('secret-');
  const artifact = path.join(directory, 'credentials.json');
  const env = {...process.env, DATABASE_URL:'', TCB_PG_PROXY:'0', DATA_DIR:directory, SETUP_ARTIFACT:artifact};
  delete env.ADMIN_PASSWORD;
  delete env.EXPERT_PASSWORD;
  const run = overrides => execute(process.execPath, ['scripts/setup.mjs'], {
    cwd, env:{...env,...overrides}, timeout:30000,
  });
  const inspect = async () => {
    const source = `import {createDb,makeRepository} from './src/db.mjs';
      import {checkPassword} from './src/auth.mjs';
      const db=createDb(), repo=makeRepository(db);
      try {const users=[];for(const name of ['admin','expert01']) {
        const u=await repo.userByName(name);
        users.push(u?{username:u.username,mustChange:u.must_change,
          originalPassword:await checkPassword(process.env[name==='admin'?'FIXTURE_ADMIN':'FIXTURE_EXPERT'],u.password_hash)}:null);
      } console.log(JSON.stringify(users));}
      catch(error){console.error(JSON.stringify({event:'fixture_failed',message:error.message,code:error.code}));process.exitCode=1;}
      finally {await db.end();}`;
    const result = await execute(process.execPath, ['--input-type=module','-e',source], {
      cwd, env:{...env,FIXTURE_ADMIN:fixtureAdmin,FIXTURE_EXPERT:fixtureExpert}, timeout:30000,
    });
    return JSON.parse(result.stdout);
  };
  try {
    // A bad expert secret must not create the administrator and then get stuck
    // behind the existing-admin guard on the next boot.
    await assert.rejects(run({ADMIN_PASSWORD:fixtureAdmin,EXPERT_PASSWORD:'too-short'}), error => {
      assert.match(error.stderr, /EXPERT_PASSWORD/);
      assert.ok(!error.stderr.includes(fixtureAdmin));
      return true;
    });
    await assert.rejects(run({ADMIN_PASSWORD:'x'.repeat(129),EXPERT_PASSWORD:fixtureExpert}), error => {
      assert.match(error.stderr,/ADMIN_PASSWORD/);
      return true;
    });
    assert.deepEqual(await inspect(), [null,null]);
    const first = await run({ADMIN_PASSWORD:fixtureAdmin,EXPERT_PASSWORD:fixtureExpert});
    assert.ok(!first.stdout.includes(fixtureAdmin) && !first.stdout.includes(fixtureExpert));
    assert.ok(!first.stderr.includes(fixtureAdmin) && !first.stderr.includes(fixtureExpert));
    const saved = await fs.readFile(artifact,'utf8');
    assert.deepEqual(await inspect(), [
      {username:'admin',mustChange:true,originalPassword:true},
      {username:'expert01',mustChange:false,originalPassword:true},
    ]);
    await run({ADMIN_PASSWORD:'replacement-admin-password',EXPERT_PASSWORD:'replacement-expert-password'});
    assert.equal(await fs.readFile(artifact,'utf8'), saved);
    assert.deepEqual(await inspect(), [
      {username:'admin',mustChange:true,originalPassword:true},
      {username:'expert01',mustChange:false,originalPassword:true},
    ]);
  } finally {
    await cleanupFixture(directory);
  }
});

test('local random bootstrap keeps mandatory first password changes', async () => {
  const directory = await fixtureDirectory('local-');
  const env = {...process.env,DATABASE_URL:'',TCB_PG_PROXY:'0',DATA_DIR:directory,SETUP_ARTIFACT:path.join(directory,'credentials.json')};
  delete env.ADMIN_PASSWORD;
  delete env.EXPERT_PASSWORD;
  try {
    await execute(process.execPath,['scripts/setup.mjs'],{cwd,env,timeout:30000});
    const source = `import {createDb,makeRepository} from './src/db.mjs';
      const db=createDb(),repo=makeRepository(db);
      try { console.log(JSON.stringify((await repo.users()).map(u=>({username:u.username,mustChange:u.must_change})).sort((a,b)=>a.username.localeCompare(b.username)))); }
      catch(error){console.error(JSON.stringify({event:'fixture_failed',message:error.message,code:error.code}));process.exitCode=1;}
      finally {await db.end();}`;
    const result=await execute(process.execPath,['--input-type=module','-e',source],{cwd,env,timeout:30000});
    assert.deepEqual(JSON.parse(result.stdout),[{username:'admin',mustChange:true},{username:'expert01',mustChange:true}]);
  } finally {
    await cleanupFixture(directory);
  }
});
