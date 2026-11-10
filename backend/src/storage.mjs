// 私有音频存储：音频字节存放在云数据库的 audio_blobs 表（bytea），
// 没有公共桶、没有直链，只能经 /api/works/:id/audio 的所有者校验后流式返回。
const KEY = /^[a-f0-9-]{36}\/[a-f0-9-]{36}$/;

export function makeStorage(db) {
  const q = (text, params) => db.query(text, params);
  return {
    valid: key => KEY.test(key),
    put: (key, buffer, type) => {
      if (!KEY.test(key)) throw new Error('非法存储键');
      return q(
        'INSERT INTO audio_blobs(key,bytes,data) VALUES($1,$2,$3) ON CONFLICT (key) DO UPDATE SET bytes=EXCLUDED.bytes, data=EXCLUDED.data, created_at=now()',
        [key, buffer.length, buffer]);
    },
    get: async key => {
      if (!KEY.test(key)) throw new Error('非法存储键');
      const row = (await q('SELECT data FROM audio_blobs WHERE key=$1', [key])).rows[0];
      if (!row) return null;
      const data = row.data;
      // 本地 pg 返回 Buffer；云通道把 bytea 以 base64 文本回传（老驱动可能是 \x 十六进制）
      if (Buffer.isBuffer(data)) return data;
      if (typeof data === 'string') {
        const trimmed = data.trim();
        if (trimmed.startsWith('\\x')) return Buffer.from(trimmed.slice(2), 'hex');
        return Buffer.from(trimmed, 'base64');
      }
      if (data && typeof data === 'object' && Array.isArray(data.data)) return Buffer.from(data.data);
      return Buffer.from(data);
    },
    has: async key => {
      if (!KEY.test(key)) return false;
      return Boolean((await q('SELECT 1 AS ok FROM audio_blobs WHERE key=$1', [key])).rows[0]);
    },
    remove: key => (KEY.test(key) ? q('DELETE FROM audio_blobs WHERE key=$1', [key]) : Promise.resolve()),
  };
}
