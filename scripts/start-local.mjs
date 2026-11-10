import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const env = {...process.env, APP_ORIGIN: process.env.APP_ORIGIN || 'http://localhost:3000'};
if (env.DATA_DIR) env.SETUP_ARTIFACT ||= path.join(env.DATA_DIR, 'setup-credentials.json');
const run = file => new Promise(resolve => {
  const child = spawn(process.execPath, [file], {cwd: root, env, stdio: 'inherit', windowsHide: true});
  child.on('exit', code => resolve(code ?? 1));
});
const setup = await run('backend/scripts/setup.mjs');
if (setup) process.exit(setup);
console.log('初始账号记录：' + (env.SETUP_ARTIFACT || path.join(root, '.lingpu/setup-credentials.json')));
process.exitCode = await run('backend/src/index.mjs');
