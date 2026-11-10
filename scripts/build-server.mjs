// Build the standalone Express service without the Sites-specific Worker bundle.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
for (const args of [['--prefix', 'backend', 'ci', '--no-audit', '--no-fund'],
  ['--prefix', 'frontend', 'ci', '--no-audit', '--no-fund'], ['--prefix', 'frontend', 'run', 'build']]) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(npm, args, {cwd:root, stdio:'inherit', windowsHide:true,
      shell: process.platform === 'win32'});
    child.on('error', reject);
    child.on('exit', value => resolve(value ?? 1));
  });
  if (code) process.exit(code);
}
