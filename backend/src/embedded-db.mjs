// PGlite runs real PostgreSQL in-process and persists to a local directory.
// One application process owns that directory. Use external PostgreSQL for
// replicas, multiple machines, or concurrent CLI maintenance.
import fs from 'node:fs';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';

export function embeddedPool(dataDir) {
  fs.mkdirSync(dataDir, {recursive: true});
  const lockFile = path.join(dataDir, '.database-owner');
  function acquire() {
    try {
      fs.writeFileSync(lockFile, String(process.pid), {flag: 'wx', mode: 0o600});
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number(fs.readFileSync(lockFile, 'utf8'));
      let alive = Number.isInteger(owner) && owner > 0;
      if (alive) {
        try { process.kill(owner, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
      }
      if (alive) throw new Error('本地数据库正被另一个进程使用。请先停止服务再运行维护脚本；多进程部署请配置 PostgreSQL。');
      fs.unlinkSync(lockFile);
      fs.writeFileSync(lockFile, String(process.pid), {flag: 'wx', mode: 0o600});
    }
  }
  acquire();
  const db = new PGlite(path.join(dataDir, 'postgres'));
  // The same lock covers plain queries and BEGIN...COMMIT transactions, so a
  // concurrent request cannot accidentally execute inside another user's tx.
  let tail = Promise.resolve();
  let closed = false;
  async function connect() {
    if (closed) throw new Error('数据库已关闭');
    const previous = tail;
    let unlock;
    tail = new Promise(resolve => { unlock = resolve; });
    await previous;
    let released = false;
    return {
      query: async (text, params) => {
        const result = await db.query(text, params);
        return {...result, rowCount: result.affectedRows ?? result.rows.length};
      },
      release: () => { if (!released) { released = true; unlock(); } },
    };
  }
  return {
    connect,
    query: async (text, params) => {
      const client = await connect();
      try { return await client.query(text, params); } finally { client.release(); }
    },
    end: async () => {
      closed = true;
      await tail;
      try { await db.close(); } finally {
        if (fs.existsSync(lockFile) && fs.readFileSync(lockFile, 'utf8') === String(process.pid)) fs.unlinkSync(lockFile);
      }
    },
  };
}
