// 读取 backend/.env 并补进 process.env（已存在的进程环境变量优先）。
// 平台托管启动不会注入站点地址等变量；本地/自建部署时，用户把 .env.example
// 复制为 .env 后即可生效，无需在系统里逐个 export。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadEnv(envFile = path.resolve(here, '../.env')) {
  if (!fs.existsSync(envFile)) return false;
  for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    // 去掉行内注释（仅处理以 # 开头且前面是空格的情况，避免误伤含 # 的密码）
    const clean = /\s#/.test(value) ? value.slice(0, value.search(/\s#/)).trim() : value;
    if (!(key in process.env)) process.env[key] = clean;
  }
  return true;
}

export default loadEnv;
