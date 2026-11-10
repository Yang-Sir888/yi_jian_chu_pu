// 服务器恢复工具：列账号、建号、重置、停用/启用。不接受命令行明文密码。
import {loadEnv} from '../src/load-env.mjs';
import {createDb, makeRepository} from '../src/db.mjs';
import {createUser, randomPassword, hashPassword} from '../src/auth.mjs';

loadEnv();

const [action, username, displayName] = process.argv.slice(2);
const db = createDb();
const repo = makeRepository(db);
try {
  if (action === 'list') {
    console.table((await repo.users()).map(u => ({username: u.username, displayName: u.display_name, admin: !!u.is_admin, disabled: !!u.disabled})));
  } else if (action === 'create') {
    const password = randomPassword();
    await createUser(repo, {username, displayName, password});
    console.log('账号：' + username + '\n初始密码（仅此次显示）：' + password);
  } else {
    const u = await repo.userByName(username);
    if (!u) throw new Error('账号不存在');
    if (action === 'reset') {
      const password = randomPassword();
      await repo.password(u.id, await hashPassword(password), true);
      console.log('账号：' + username + '\n新密码（仅此次显示）：' + password);
    } else if (['disable', 'enable'].includes(action)) {
      if (u.is_admin) throw new Error('禁止停用管理员');
      await repo.disabled(u.id, action === 'disable');
      console.log('已更新');
    } else {
      throw new Error('用法：node scripts/user.mjs list|create|reset|disable|enable [账号] [姓名]');
    }
  }
} finally {
  await db.end().catch(() => {});
}
