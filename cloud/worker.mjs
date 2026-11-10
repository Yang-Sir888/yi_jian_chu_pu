// Portable Cloudflare Worker adapter. D1 is private; R2 objects have no public URL.
// Bootstrap passwords and the 32-byte AES key come only from runtime secrets.
import {assertScore, assertWork} from '../backend/core/validation.mjs';
import {validateModelSettings} from '../backend/src/config.mjs';
import {runAgent, testModelConnection} from '../backend/src/agent.mjs';

const MAX_AUDIO = 20 * 1024 * 1024, MAX_PAYLOAD = 1500000, PBKDF_ROUNDS = 100000;
const encoder = new TextEncoder(), booted = new WeakMap();
const now = () => new Date().toISOString();
const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const unhex = text => Uint8Array.from(text.match(/../g) || [], x => parseInt(x, 16));
const random = (size = 32) => hex(crypto.getRandomValues(new Uint8Array(size)));
const digest = async text => hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
const stmt = (env, sql, ...values) => env.DB.prepare(sql).bind(...values);
const one = (env, sql, ...values) => stmt(env, sql, ...values).first();
const all = async (env, sql, ...values) => (await stmt(env, sql, ...values).all()).results;
const exec = (env, sql, ...values) => stmt(env, sql, ...values).run();
const publicUser = u => ({id:u.id, username:u.username, displayName:u.display_name, admin:!!u.is_admin, mustChange:!!u.must_change, disabled:!!u.disabled});
const initialHealth = () => ({status:'unconfigured', checkedAt:null, message:''});
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {status, headers:{'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...headers}});
function validatePassword(password) {
 if (typeof password !== 'string' || password.length < 12 || password.length > 128) fail(400, '密码长度须为 12–128 个字符');
}
async function derive(password, salt) {
 const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
 return hex(await crypto.subtle.deriveBits({name:'PBKDF2', salt:unhex(salt), iterations:PBKDF_ROUNDS, hash:'SHA-256'}, key, 256));
}
export async function hashPassword(password) {
 validatePassword(password); const salt = random(16);
 return `pbkdf2:${PBKDF_ROUNDS}:${salt}:${await derive(password, salt)}`;
}
async function checkPassword(password, encoded) {
 if (typeof password !== 'string' || password.length > 128) return false;
 const fields = String(encoded || '').split(':'), valid = fields[0] === 'pbkdf2' && fields[1] === String(PBKDF_ROUNDS) && /^[a-f0-9]{32}$/.test(fields[2]) && /^[a-f0-9]{64}$/.test(fields[3]);
 const actual = await derive(password, valid ? fields[2] : '0'.repeat(32));
 const expected = valid ? fields[3] : '0'.repeat(64); let mismatch = valid ? 0 : 1;
 for (let i = 0; i < 64; i++) mismatch |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
 return mismatch === 0;
}
async function bootstrap(env) {
 if (!env.DB || !env.BUCKET) fail(503, '数据库或音频存储尚未绑定');
 let pending = booted.get(env.DB);
 if (!pending) {
  pending = (async () => {
   for (const [username, password, admin, display] of [['admin',env.ADMIN_PASSWORD,1,'平台管理员'], ['expert01',env.EXPERT_PASSWORD,0,'评审专家']]) {
    if (await one(env, 'SELECT id FROM users WHERE username=?', username)) continue;
    validatePassword(password);
    const passwordHash = await hashPassword(password);
    await exec(env, 'INSERT OR IGNORE INTO users(id,username,display_name,password_hash,is_admin,must_change,created_at) VALUES(?,?,?,?,?,?,?)', crypto.randomUUID(), username, display, passwordHash, admin, admin ? 1 : 0, now());
   }
  })();
  booted.set(env.DB, pending);
  pending.catch(() => booted.delete(env.DB));
 }
 await pending;
}
async function readJson(request, maximum = 2 * 1024 * 1024) {
 const data = await boundedBody(request, maximum);
 try { return JSON.parse(new TextDecoder().decode(data)); } catch { fail(400, '请求 JSON 格式不正确'); }
}
async function boundedBody(request, maximum) {
 const length = Number(request.headers.get('content-length') || 0);
 if (length > maximum) fail(413, '请求内容超出大小限制');
 const reader = request.body?.getReader(); if (!reader) return new Uint8Array();
 const chunks=[]; let size=0;
 try { while (true) { const {done,value}=await reader.read(); if (done) break; size+=value.byteLength; if(size>maximum){await reader.cancel();fail(413,'请求内容超出大小限制');} chunks.push(value); } }
 finally { reader.releaseLock(); }
 const result = new Uint8Array(size); let offset=0; for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;} return result;
}
async function limit(env, key, maximum, duration = 60000) {
 const time=Date.now(), window=Math.floor(time/duration), expires=(window+1)*duration;
 const reserved=await one(env, 'INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count<? RETURNING count', `${key}:${window}`, expires, maximum);
 if(!reserved) fail(429,'操作过于频繁或今日调用已达上限，请稍后重试');
}
function cookieToken(request) {return (request.headers.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('jianpu_session='))?.slice(15);}
function cookie(request, token, age = 28800) {return `jianpu_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${new URL(request.url).protocol==='https:'?'; Secure':''}`;}
async function setting(env,key) {const row=await one(env,'SELECT value FROM app_settings WHERE key=?',key);return row?JSON.parse(row.value):null;}
async function setSetting(env,key,value) {await exec(env,'INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,JSON.stringify(value));}
async function health(env) {return await setting(env,'model_health') || initialHealth();}
async function sessionResponse(env,u,csrf) {return {user:publicUser(u), modelHealth:await health(env), localMode:false, csrf};}
async function issue(request,env,u) {
 const old=cookieToken(request),token=random(),csrf=random(24);
 const commands=[stmt(env,'DELETE FROM sessions WHERE expires_at<?',Date.now())];
 if(old)commands.push(stmt(env,'DELETE FROM sessions WHERE token_hash=?',await digest(old)));
 commands.push(stmt(env,'INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)',await digest(token),u.id,csrf,Date.now()+28800000));
 await env.DB.batch(commands);
 return json(await sessionResponse(env,u,csrf),200,{'Set-Cookie':cookie(request,token)});
}
async function authenticated(request,env) {
 const token=cookieToken(request);if(!token||!/^[a-f0-9]{64}$/.test(token))fail(401,'请先登录');
 const u=await one(env,'SELECT u.*,s.csrf FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0',await digest(token),Date.now());
 if(!u)fail(401,'请先登录');
 if(!['GET','HEAD'].includes(request.method)&&request.headers.get('x-csrf-token')!==u.csrf)fail(403,'会话校验失败，请刷新页面');
 return u;
}
async function vaultKey(env) {
 let bytes;try {bytes=Uint8Array.from(atob(env.MODEL_VAULT_KEY||''),c=>c.charCodeAt(0));}catch{}
 if(bytes?.length!==32)fail(503,'模型密钥加密服务尚未配置');
 return crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt','decrypt']);
}
async function seal(env,text) {
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},await vaultKey(env),encoder.encode(text));
 return {iv:hex(iv),data:hex(cipher)};
}
async function modelConfig(env) {
 const saved=await setting(env,'model_settings');
 if(!saved)return {baseUrl:'',model:'qwen-plus',apiKey:'',timeoutMs:45000};
 let apiKey='';
 if(saved.key){try {apiKey=new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unhex(saved.key.iv)},await vaultKey(env),unhex(saved.key.data)));}catch{fail(503,'服务端模型密钥无法解密，请联系管理员重新配置');}}
 return {...validateModelSettings({baseUrl:saved.baseUrl,model:saved.model,apiKey:apiKey||undefined}),apiKey,timeoutMs:45000};
}
async function executeModel(request,env,u,body,isWork) {
 if(isWork){assertScore(body.score);if(typeof body.instruction!=='string'||body.instruction.length>2000)fail(400,'记谱要求最多 2000 字');}
 await limit(env,`model:${u.id}`,isWork?12:3);
 const config=await modelConfig(env), paid=!!(config.apiKey&&config.baseUrl&&(!isWork||body.instruction.trim()));
 const lease=crypto.randomUUID();
 if(paid){
  await exec(env,'DELETE FROM model_leases WHERE expires_at<?',Date.now());
  const count=Math.max(1,Math.min(2,Number(env.MAX_MODEL_CONCURRENCY)||2));
  const reserved=await one(env,'INSERT INTO model_leases(id,expires_at) SELECT ?,? WHERE (SELECT COUNT(*) FROM model_leases)<? RETURNING id',lease,Date.now()+90000,count);
  if(!reserved)fail(429,'智能整理任务繁忙，请稍后重试');
 }
 try {
  if(paid)await limit(env,'paid-model',Math.max(1,Math.min(100000,Number(env.MAX_MODEL_CALLS_PER_DAY)||100)),86400000);
  const result=isWork?await runAgent(body.score,body.instruction,config,{signal:request.signal}):await testModelConnection(config,{signal:request.signal});
  let state=await health(env);
  if(!isWork||result.modelStatus!=='not_run'){
   state={status:(isWork?result.modelStatus==='success':result.ok)?'success':result.modelStatus==='unconfigured'||!config.apiKey?'unconfigured':'failed',checkedAt:now(),message:result.errorMessage||result.report||result.message||''};
   await setSetting(env,'model_health',state);
  }
  return json({...result,modelHealth:state});
 }finally{if(paid)await exec(env,'DELETE FROM model_leases WHERE id=?',lease);}
}

// Validate actual container bytes, channels and duration; no extension trust.
// WAV is structurally validated and sampled for silence. MP3 frames are parsed
// for duration/integrity; perceptual/silence checks still occur in browser decode.
export function inspectAudio(bytes) {
 const error=()=>fail(400,'录音须为有效 MP3/WAV，且不超过 3 分钟');
 if(bytes.length>MAX_AUDIO)fail(413,'录音超过 20 MB');if(bytes.length<44)error();
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength), ascii=(at,n)=>String.fromCharCode(...bytes.subarray(at,at+n));
 if(ascii(0,4)==='RIFF'&&ascii(8,4)==='WAVE'){
  if(view.getUint32(4,true)+8>bytes.length)error();
  let fmt=null,parts=[];
  for(let at=12;at+8<=bytes.length;){const kind=ascii(at,4),size=view.getUint32(at+4,true),data=at+8;if(data+size>bytes.length)error();
   if(kind==='fmt '){if(size<16)error();let format=view.getUint16(data,true);if(format===65534&&size>=40)format=view.getUint16(data+24,true);fmt={format,channels:view.getUint16(data+2,true),rate:view.getUint32(data+4,true),align:view.getUint16(data+12,true),bits:view.getUint16(data+14,true)};}
   if(kind==='data')parts.push({start:data,size});at=data+size+(size&1);
  }
  if(!fmt||![1,3].includes(fmt.format)||fmt.channels<1||fmt.channels>8||fmt.rate<8000||fmt.rate>384000||![8,16,24,32,64].includes(fmt.bits)||fmt.align!==fmt.channels*fmt.bits/8||!parts.length)error();
  if(fmt.format===3&&![32,64].includes(fmt.bits))error();if(fmt.format===1&&fmt.bits===64)error();
  const size=parts.reduce((s,p)=>s+p.size,0),duration=size/fmt.align/fmt.rate;if(duration<=0||duration>180)error();
  let audible=false;
  for(const part of parts){if(part.size%fmt.align)error();const step=Math.max(1,Math.floor(part.size/(fmt.bits/8)/100000))*(fmt.bits/8);
   for(let at=part.start;at+fmt.bits/8<=part.start+part.size;at+=step){let value;
    if(fmt.format===3)value=fmt.bits===32?view.getFloat32(at,true):view.getFloat64(at,true);
    else if(fmt.bits===8)value=(view.getUint8(at)-128)/128;
    else if(fmt.bits===16)value=view.getInt16(at,true)/32768;
    else if(fmt.bits===24)value=((bytes[at]|bytes[at+1]<<8|bytes[at+2]<<16)<<8>>8)/8388608;
    else value=view.getInt32(at,true)/2147483648;
    if(Number.isFinite(value)&&Math.abs(value)>0.000001)audible=true;
   }
  }
  if(!audible)fail(400,'录音为空或完全静音');return {type:'audio/wav',duration};
 }
 let at=0;
 if(ascii(0,3)==='ID3'){
  if(bytes.subarray(6,10).some(x=>x&128))error();
  const size=(bytes[6]<<21)|(bytes[7]<<14)|(bytes[8]<<7)|bytes[9];at=10+size+(bytes[5]&16?10:0);if(at>=bytes.length)error();
 }
 const mpeg1=[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320],mpeg2=[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
 let duration=0,frames=0;
 while(at+4<=bytes.length){
  if(ascii(at,3)==='TAG'&&bytes.length-at===128)break;
  if(bytes[at]===0&&bytes.subarray(at).every(x=>x===0))break;
  const a=bytes[at],b=bytes[at+1],c=bytes[at+2],version=(b>>3)&3,layer=(b>>1)&3,rateIndex=(c>>2)&3,bitIndex=c>>4;
  if(a!==255||(b&224)!==224||version===1||layer!==1||rateIndex===3||bitIndex===0||bitIndex===15)error();
  const rate=[44100,48000,32000][rateIndex]/(version===3?1:version===2?2:4),bitrate=(version===3?mpeg1:mpeg2)[bitIndex]*1000;
  const size=Math.floor((version===3?144:72)*bitrate/rate)+((c>>1)&1);
  if(at+size>bytes.length)error();duration+=(version===3?1152:576)/rate;frames++;at+=size;if(duration>180)error();
 }
 if(frames<2||duration<=0||bytes.length-at>128)error();return {type:'audio/mpeg',duration};
}
async function removeBlob(env,key) {
 if(!key||await one(env,'SELECT id FROM works WHERE audio_key=?',key))return;
 await env.BUCKET.delete(key);await exec(env,'DELETE FROM blobs WHERE key=?',key);
}
export async function cleanup(env) {
 const unused=await all(env,'SELECT key FROM blobs WHERE created_at<? AND NOT EXISTS(SELECT 1 FROM works WHERE audio_key=blobs.key) LIMIT 10',Date.now()-3600000);
 for(const row of unused)await removeBlob(env,row.key);
 await env.DB.batch([stmt(env,'DELETE FROM sessions WHERE expires_at<?',Date.now()),stmt(env,'DELETE FROM rate_limits WHERE expires_at<?',Date.now()-86400000),stmt(env,'DELETE FROM model_leases WHERE expires_at<?',Date.now())]);
}
async function saveWork(request,env,u,id) {
 await limit(env,`save:${u.id}`,30);
 const old=id?await one(env,'SELECT * FROM works WHERE id=? AND owner_id=?',id,u.id):null;if(id&&!old)fail(404,'作品不存在');
 const bytes=await boundedBody(request,MAX_AUDIO+2*1024*1024);
 let form;try {form=await new Response(bytes,{headers:{'Content-Type':request.headers.get('content-type')||''}}).formData();}catch{fail(400,'作品上传格式不正确');}
 const raw=form.get('payload');if(typeof raw!=='string'||encoder.encode(raw).byteLength>MAX_PAYLOAD)fail(400,'作品数据无效或超过大小限制');
 let payload;try {payload=assertWork(JSON.parse(raw));}catch(error){fail(400,error.status===400?error.message:'作品格式不正确');}
 const version=Number(form.get('version'));if(old&&(!Number.isInteger(version)||version!==Number(old.version)))fail(409,'版本冲突，请先导出当前谱面，再重新打开作品');
 const file=form.get('audio');if(file!==null&&typeof file.arrayBuffer!=='function')fail(400,'音频上传格式不正确');
 let audio=null;
 try {
  if(file){const data=new Uint8Array(await file.arrayBuffer()),info=inspectAudio(data),key=`${u.id}/${crypto.randomUUID()}`;
   const maxBytes=Math.max(1,Number(env.MAX_STORAGE_MB)||4096)*1024*1024;
   const reservation=await one(env,'INSERT INTO blobs(key,bytes,created_at) SELECT ?,?,? WHERE (SELECT COALESCE(SUM(bytes),0) FROM blobs)+?<=? RETURNING key',key,data.length,Date.now(),data.length,maxBytes);
   if(!reservation)fail(507,'私有存储空间已满，请联系管理员');
   audio={key,type:info.type,name:String(file.name||'录音').slice(0,160)};
   await env.BUCKET.put(key,data,{httpMetadata:{contentType:audio.type}});
  }
  const workId=id||crypto.randomUUID(),time=now();let saved;
  if(old)saved=await one(env,'UPDATE works SET version=version+1,payload=?,audio_key=COALESCE(?,audio_key),audio_type=COALESCE(?,audio_type),audio_name=COALESCE(?,audio_name),updated_at=? WHERE id=? AND owner_id=? AND version=? RETURNING id,version,audio_key',JSON.stringify(payload),audio?.key??null,audio?.type??null,audio?.name??null,time,workId,u.id,version);
  else saved=await one(env,'INSERT INTO works(id,owner_id,version,payload,audio_key,audio_type,audio_name,created_at,updated_at) VALUES(?,?,1,?,?,?,?,?,?) RETURNING id,version,audio_key',workId,u.id,JSON.stringify(payload),audio?.key??null,audio?.type??null,audio?.name??null,time,time);
  if(!saved)fail(409,'版本冲突，请先导出当前谱面，再重新打开作品');
  if(audio&&old?.audio_key)await removeBlob(env,old.audio_key).catch(()=>{});
  return json({id:saved.id,version:saved.version,audioUrl:saved.audio_key?`/api/works/${saved.id}/audio`:null});
 }catch(error){if(audio)await removeBlob(env,audio.key).catch(()=>{});throw error;}
}
async function api(request,env,context) {
 const url=new URL(request.url),path=url.pathname,method=request.method;
 if(!['GET','HEAD'].includes(method)){
  const origin=request.headers.get('origin');if(origin&&origin!==url.origin)fail(403,'请从正式网站操作，当前地址与服务配置不一致');
 }
 await bootstrap(env);
 if(path==='/api/health'&&method==='GET')return json({ok:true,version:'2.2.0-cloud',database:true});
 if(path==='/api/auth/login'&&method==='POST'){
  // Platform headers are inserted by the trusted edge; usernames add a second
  // account limit so distributed guesses cannot bypass an individual account.
  const address=request.headers.get('cf-connecting-ip')||'unknown';await limit(env,`login-ip:${await digest(address)}`,15,900000);
  const body=await readJson(request,4096);
  if(typeof body.username!=='string'||body.username.length>48||typeof body.password!=='string'||body.password.length>128)fail(400,'请输入有效账号和密码');
  const name=body.username.trim().toLowerCase();await limit(env,`login-user:${name}`,15,900000);
  const u=await one(env,'SELECT * FROM users WHERE username=?',name),ok=await checkPassword(body.password,u?.password_hash);
  if(!ok||!u||u.disabled)fail(401,'账号或密码不正确，或账号已停用');
  await exec(env,'UPDATE users SET last_login_at=? WHERE id=?',now(),u.id);
  return issue(request,env,u);
 }
 const u=await authenticated(request,env);
 if(u.must_change&&!['/api/auth/me','/api/auth/password','/api/auth/logout'].includes(path))fail(403,'首次登录请先修改密码');
 // Recover interrupted uploads even when the host does not configure cron.
 // The hour-long staging grace protects uploads still being committed.
 if(context?.waitUntil&&path.startsWith('/api/works')&&['POST','PUT'].includes(method))context.waitUntil(cleanup(env).catch(()=>{}));
 if(path==='/api/auth/me'&&method==='GET')return json(await sessionResponse(env,u,u.csrf));
 if(path==='/api/auth/logout'&&method==='POST'){
  await exec(env,'DELETE FROM sessions WHERE token_hash=?',await digest(cookieToken(request)));return json({ok:true},200,{'Set-Cookie':cookie(request,'',0)});
 }
 if(path==='/api/auth/password'&&method==='POST'){
  await limit(env,`password:${u.id}`,6,900000);const body=await readJson(request,4096);
  if(!await checkPassword(body.currentPassword,u.password_hash))fail(400,'当前密码不正确');if(body.newPassword===body.currentPassword)fail(400,'新密码不能与原密码相同');
  const hash=await hashPassword(body.newPassword);
  await env.DB.batch([stmt(env,'UPDATE users SET password_hash=?,must_change=0 WHERE id=?',hash,u.id),stmt(env,'DELETE FROM sessions WHERE user_id=?',u.id)]);
  return issue(request,env,{...u,must_change:0});
 }
 if(path.startsWith('/api/admin/')&&!u.is_admin)fail(403,'仅管理员可操作');
 if(path==='/api/admin/users'&&method==='GET')return json((await all(env,'SELECT * FROM users ORDER BY created_at')).map(publicUser));
 if(path==='/api/admin/users'&&method==='POST'){
  await limit(env,`admin:${u.id}`,20);const body=await readJson(request,4096),name=typeof body.username==='string'?body.username.trim().toLowerCase():'';
  if(!/^[a-z0-9_.-]{3,48}$/.test(name)||(body.displayName!==undefined&&typeof body.displayName!=='string'))fail(400,'账号为 3–48 位字母、数字或 _ . -');
  if(await one(env,'SELECT id FROM users WHERE username=?',name))fail(409,'该账号已存在');
  const password=random(15),id=crypto.randomUUID(),display=body.displayName?.trim().slice(0,80)||name;
  try {await exec(env,'INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,?)',id,name,display,await hashPassword(password),now());}catch(error){if(String(error.message).includes('UNIQUE'))fail(409,'该账号已存在');throw error;}
  return json({user:publicUser({id,username:name,display_name:display,must_change:1}),initialPassword:password});
 }
 const action=path.match(/^\/api\/admin\/users\/([a-f0-9-]{36})\/(reset|disabled)$/);
 if(action&&method==='POST'){
  await limit(env,`admin:${u.id}`,20);const target=await one(env,'SELECT * FROM users WHERE id=?',action[1]);if(!target||target.is_admin)fail(400,'只能操作专家账号');
  if(action[2]==='reset'){
   const password=random(15);await env.DB.batch([stmt(env,'UPDATE users SET password_hash=?,must_change=1 WHERE id=?',await hashPassword(password),target.id),stmt(env,'DELETE FROM sessions WHERE user_id=?',target.id)]);return json({initialPassword:password});
  }
  const body=await readJson(request,4096);if(typeof body.disabled!=='boolean')fail(400,'停用状态无效');
  await env.DB.batch([stmt(env,'UPDATE users SET disabled=? WHERE id=?',body.disabled?1:0,target.id),stmt(env,'DELETE FROM sessions WHERE user_id=?',target.id)]);return json({ok:true});
 }
 if(path==='/api/admin/model'&&method==='GET'){
  const saved=await setting(env,'model_settings');return json({baseUrl:saved?.baseUrl||'',model:saved?.model||'qwen-plus',keySet:!!saved?.key,health:await health(env)});
 }
 if(path==='/api/admin/model'&&method==='PUT'){
  await limit(env,`model-setting:${u.id}`,10);const next=validateModelSettings(await readJson(request,8192)),saved=await setting(env,'model_settings');
  const key=next.apiKey?await seal(env,next.apiKey):saved?.key;if(!key)fail(400,'请填写完整密钥');
  const state={status:'pending',checkedAt:null,message:'配置已保存，尚未验证'};
  await env.DB.batch([stmt(env,'INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value','model_settings',JSON.stringify({baseUrl:next.baseUrl,model:next.model,key})),stmt(env,'INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value','model_health',JSON.stringify(state))]);return json({health:state});
 }
 if(path==='/api/admin/model/test'&&method==='POST')return executeModel(request,env,u,{},false);
 if(path==='/api/agent'&&method==='POST')return executeModel(request,env,u,await readJson(request),true);
 if(path==='/api/model/status'&&method==='GET')return json(await health(env));
 if(path==='/api/works'&&method==='GET')return json(await all(env,"SELECT id,version,json_extract(payload,'$.score.title') AS title,json_extract(payload,'$.engine') AS engine,updated_at FROM works WHERE owner_id=? ORDER BY updated_at DESC LIMIT 200",u.id));
 if(path==='/api/works'&&method==='POST')return saveWork(request,env,u,null);
 const work=path.match(/^\/api\/works\/([a-f0-9-]{36})(\/audio)?$/);
 if(work){
  const row=await one(env,'SELECT * FROM works WHERE id=? AND owner_id=?',work[1],u.id);if(!row)fail(404,'作品不存在');
  if(work[2]&&method==='GET'){
   if(!row.audio_key)fail(404,'录音不存在');const audio=await env.BUCKET.get(row.audio_key);if(!audio)fail(404,'录音不存在');
   return new Response(audio.body,{headers:{'Content-Type':row.audio_type||'audio/mpeg','Content-Disposition':'inline','Cache-Control':'private, no-store','Accept-Ranges':'none'}});
  }
  if(!work[2]&&method==='GET')return json({id:row.id,version:row.version,...JSON.parse(row.payload),audioUrl:row.audio_key?`/api/works/${row.id}/audio`:null,audioName:row.audio_name});
  if(!work[2]&&method==='PUT')return saveWork(request,env,u,row.id);
  if(!work[2]&&method==='DELETE'){
   await exec(env,'DELETE FROM works WHERE id=? AND owner_id=?',row.id,u.id);await removeBlob(env,row.audio_key).catch(()=>{});return json({ok:true});
  }
 }
 if(context?.waitUntil)context.waitUntil(cleanup(env).catch(()=>{}));
 fail(404,'接口不存在');
}
const securityHeaders={
 'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','X-Frame-Options':'SAMEORIGIN',
 'Cross-Origin-Resource-Policy':'same-origin',
 'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
 'Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
};
export default {
 async fetch(request,env,context) {
  const path=new URL(request.url).pathname;let response;
  try {
   if(path==='/api'||path.startsWith('/api/'))response=await api(request,env,context);
   else if(env.ASSETS)response=await env.ASSETS.fetch(request);
   else response=new Response('静态页面尚未发布',{status:503});
  }catch(error){const status=error.status||500;console.error(JSON.stringify({event:'worker_request_failed',status}));response=json({error:status>=500&&status!==507?'服务暂时不可用，请联系管理员':error.message},status);}
  const headers=new Headers(response.headers);for(const [key,value] of Object.entries(securityHeaders))headers.set(key,value);
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
 },
 async scheduled(_event,env,context){context.waitUntil(cleanup(env));}
};
