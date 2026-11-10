import {sql, statements} from './sql.mjs';

// The platform's migration channel does not guarantee DDL ordering, so the
// server verifies and creates its own objects idempotently on boot.
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id uuid PRIMARY KEY,
     username text UNIQUE NOT NULL,
     display_name text NOT NULL,
     password_hash text NOT NULL,
     is_admin boolean NOT NULL DEFAULT false,
     disabled boolean NOT NULL DEFAULT false,
     must_change boolean NOT NULL DEFAULT true,
     created_at timestamptz NOT NULL DEFAULT now(),
     last_login_at timestamptz
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash text PRIMARY KEY,
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     csrf text NOT NULL,
     expires_at timestamptz NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at)',
  `CREATE TABLE IF NOT EXISTS works (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     version integer NOT NULL DEFAULT 1,
     payload jsonb NOT NULL,
     audio_key text,
     audio_type text,
     audio_name text,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  'CREATE INDEX IF NOT EXISTS works_owner ON works(owner_id, updated_at DESC)',
  `CREATE TABLE IF NOT EXISTS audio_blobs (
     key text PRIMARY KEY,
     bytes integer NOT NULL,
     data bytea NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS blob_cleanup (
     key text PRIMARY KEY,
     due_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS app_settings (
     key text PRIMARY KEY,
     value jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS schema_migrations (
     version integer PRIMARY KEY,
     applied_at timestamptz NOT NULL DEFAULT now()
   )`,
];
export async function ensureSchema(db) {
  // 本地 / 自建：连接自带建表权限，直接执行 DDL。
  if (!(await adminRpcAvailable(db))) {
    for (const statement of SCHEMA) await db.query(statement);
    return db;
  }
  for (const statement of SCHEMA) {
    try {
      await sql(db, statement);
    } catch (error) {
      // 42710 / already exists = 平台控制台已建过，可忽略
      if (error.code !== '42710' && !/already exists/i.test(String(error.message))) throw error;
    }
  }
  await sql(db, "INSERT INTO schema_migrations(version) VALUES (2) ON CONFLICT DO NOTHING");
  return db;
}

async function adminRpcAvailable(db) {
  try {
    const r = await db.query("SELECT to_regprocedure('lingpu_admin_rpc()') IS NOT NULL AS ok");
    return r.rows[0].ok === true;
  } catch {
    return false;
  }
}

export {sql, statements, adminRpcAvailable};
