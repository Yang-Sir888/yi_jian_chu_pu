import {build} from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const target = path.join(root, 'dist');
await fs.mkdir(path.join(target, 'server'), {recursive: true});
await fs.cp(path.join(root, 'frontend/dist'), path.join(target, 'client'), {recursive: true});
await build({entryPoints: [path.join(root, 'cloud/worker.mjs')], outfile: path.join(target, 'server/index.js'),
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'], minify: false});
await fs.mkdir(path.join(target, '.openai'), {recursive: true});
await fs.copyFile(path.join(root, '.openai/hosting.json'), path.join(target, '.openai/hosting.json'));
const migrations = await fs.readdir(path.join(root, 'cloud/migrations'));
await fs.mkdir(path.join(root, 'drizzle/meta'), {recursive: true});
const entries = [];
for (const [idx, filename] of migrations.filter(x => x.endsWith('.sql')).sort().entries()) {
  const tag = filename.replace('.sql', '');
  await fs.copyFile(path.join(root, 'cloud/migrations', filename), path.join(root, 'drizzle', filename));
  entries.push({idx, version: '6', when: 1794276000000 + idx, tag, breakpoints: true});
}
await fs.writeFile(path.join(root, 'drizzle/meta/_journal.json'), JSON.stringify({version: '7', dialect: 'sqlite', entries}, null, 2));
await fs.cp(path.join(root, 'drizzle'), path.join(target, '.openai/drizzle'), {recursive: true});
await fs.writeFile(path.join(target, 'server/wrangler.json'), JSON.stringify({
  name: 'guoyun-puyin', main: 'index.js', compatibility_date: '2026-05-15', compatibility_flags: ['nodejs_compat'],
  assets: {directory: '../client', binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: ['/api/*']},
  d1_databases: [{binding: 'DB', database_name: 'guoyun-db', database_id: '00000000-0000-4000-8000-000000000000', migrations_dir: '../../cloud/migrations'}],
  r2_buckets: [{binding: 'BUCKET', bucket_name: 'guoyun-audio'}]
}, null, 2));
console.log('Cloud Worker, browser assets and database migrations built.');
