// 模型密钥的本地保险箱。
//
// 管理员在页面填写的 API Key 不直接以明文进数据库：先用一把只存在于服务器上的
// 主密钥做 AES-256-GCM 加密，密文才落库。这样即使有人读到数据库记录（备份、导出、
// 误开的查询权限），拿到的也只是一串无法直接使用的密文。
//
// 主密钥来源，按优先级：
//   1. 环境变量 MODEL_VAULT_KEY（base64，32 字节）——自建部署时推荐，便于集中管理
//   2. backend/.model-vault.key 本地文件（首次运行自动生成，权限 600）
// 两者都没有且需要写密钥时才生成文件。主密钥本身绝不进数据库、绝不回传浏览器。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const KEY_FILE = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR, '.model-vault.key')
  : path.resolve(here, '../.model-vault.key');
const ALGO = 'aes-256-gcm';
const PREFIX = 'v1';

let cached = null;

function masterKey() {
  if (cached) return cached;
  const fromEnv = (process.env.MODEL_VAULT_KEY || '').trim();
  if (fromEnv) {
    const buf = Buffer.from(fromEnv, 'base64');
    if (buf.length !== 32) throw new Error('MODEL_VAULT_KEY 必须是 base64 编码的 32 字节密钥');
    cached = buf;
    return cached;
  }
  if (fs.existsSync(KEY_FILE)) {
    const buf = Buffer.from(fs.readFileSync(KEY_FILE, 'utf-8').trim(), 'base64');
    if (buf.length !== 32) throw new Error('.model-vault.key 内容损坏');
    cached = buf;
    return cached;
  }
  // 首次使用：生成并落盘，文件权限仅属主可读。
  const generated = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(KEY_FILE), {recursive: true});
  fs.writeFileSync(KEY_FILE, generated.toString('base64'), {mode: 0o600});
  try { fs.chmodSync(KEY_FILE, 0o600); } catch { /* 某些文件系统不支持 chmod，忽略 */ }
  cached = generated;
  return cached;
}

// 是否是本模块产出的密文包装
export function isSealed(value) {
  return typeof value === 'string' && value.startsWith(PREFIX + '.');
}

export function seal(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, masterKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join('.');
}

export function unseal(sealed) {
  if (!isSealed(sealed)) return null;
  const [, ivB64, tagB64, dataB64] = sealed.split('.');
  if (!ivB64 || !tagB64 || !dataB64) return null;
  try {
    const decipher = crypto.createDecipheriv(ALGO, masterKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // 主密钥变更或数据损坏：解不开就当作没配置，绝不把密文当密钥用。
    return null;
  }
}

// 给测试与运维用：确认保险箱文件是否可写
export function vaultFile() {
  return KEY_FILE;
}
