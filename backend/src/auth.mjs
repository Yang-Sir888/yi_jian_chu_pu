import {randomBytes,randomUUID,scrypt as callback,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(callback);
export const digest=t=>createHash('sha256').update(t).digest('hex');
export const randomPassword=()=>randomBytes(15).toString('base64url');
export async function hashPassword(password){
 if(typeof password!=='string'||password.length<12||password.length>128)throw Object.assign(new Error('密码长度须为 12–128 个字符'),{status:400});
 const salt=randomBytes(16).toString('hex'),key=await scrypt(password,salt,64);
 return salt+':'+Buffer.from(key).toString('hex');
}
export async function checkPassword(password,encoded){
 if(typeof password!=='string'||password.length>128)return false;
 const [salt,hash]=String(encoded).split(':'),actual=Buffer.from(await scrypt(password,salt,64)),expected=Buffer.from(hash,'hex');
 return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
export async function createUser(repo,{username,displayName,password,admin=false,mustChange=true}){
 if(typeof username!=='string'||(displayName!==undefined&&typeof displayName!=='string'))throw Object.assign(new Error('请输入有效账号和显示名称'),{status:400});
 username=username.trim().toLowerCase();
 if(!/^[a-zA-Z0-9_.-]{3,48}$/.test(username))throw Object.assign(new Error('账号为 3–48 位字母、数字或 _ . -'),{status:400});
 if(await repo.userByName(username))throw Object.assign(new Error('该账号已存在'),{status:409});
 const id=randomUUID();await repo.createUser({id,username,display_name:displayName?.trim().slice(0,80)||username,password_hash:await hashPassword(password),is_admin:admin,must_change:mustChange});return id;
}
export function makeSession(repo,id){
 const token=randomBytes(32).toString('hex'),csrf=randomBytes(24).toString('hex');return {token,csrf,pending:Promise.resolve(repo.addSession(digest(token),id,csrf))};
}
export function cookieToken(req){return (req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('jianpu_session='))?.slice(15);}
export const publicUser=u=>({id:u.id,username:u.username,displayName:u.display_name,admin:!!u.is_admin,mustChange:!!u.must_change,disabled:!!u.disabled});
