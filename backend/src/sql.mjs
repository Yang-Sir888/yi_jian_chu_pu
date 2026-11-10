// 建表/迁移引导。
// 云端连接用的是平台的服务端角色，只有表级读写权限（没有 CREATE），
// 所以 DDL 统一经 lingpu_admin_rpc(statement) 这个 SECURITY DEFINER 函数执行。
let cachedRpc = null;

async function rpcName(db) {
  if (cachedRpc !== null) return cachedRpc;
  const r = await db.query('SELECT lingpu_admin_rpc() AS name');
  cachedRpc = r.rows[0].name;
  return cachedRpc;
}

export async function sql(db, statement) {
  const fn = await rpcName(db);
  const r = await db.query(`SELECT ${fn}($1) AS result`, [statement]);
  return r.rows[0].result;
}

// 单条执行：管理函数一次只接受一个命令。
export async function statements(db, list) {
  const out = [];
  for (const statement of list) out.push(await sql(db, statement));
  return out;
}
