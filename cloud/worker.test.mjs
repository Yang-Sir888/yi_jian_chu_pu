import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker, {inspectAudio, cleanup} from './worker.mjs';
import {demoScore, midiOf} from '../backend/core/music.mjs';
import {wav} from '../backend/tests/fixtures.mjs';

// Exercise production SQL and WebCrypto against SQLite, matching D1's surface.
function database() {
 const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('./migrations/0001.sql',import.meta.url),'utf8'));
 const wrap=(sql,values=[])=>({
  bind(...next){return wrap(sql,next);},
  async first(){return db.prepare(sql).get(...values)||null;},
  async all(){return {results:db.prepare(sql).all(...values),success:true};},
  async run(){const result=db.prepare(sql).run(...values);return {success:true,meta:{changes:Number(result.changes)}};},
  sql,values
 });
 return {prepare:wrap,async batch(commands){db.exec('BEGIN');try {const result=[];for(const command of commands){result.push(await command.run());}db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}},db};
}
function bucket() {
 const objects=new Map();return {objects,
  async put(key,bytes){objects.set(key,new Uint8Array(bytes));},
  async get(key){const data=objects.get(key);return data?{body:new Blob([data]).stream()}:null;},
  async delete(key){objects.delete(key);}
 };
}
const origin='https://score.example';
const payload=()=>{const score=demoScore();return {score,original:structuredClone(score),instruction:'',engine:'demo',events:[],report:'示例谱',rawEvents:[],sourceOffset:0,modelStatus:'not_run'};};
function harness() {
 const env={DB:database(),BUCKET:bucket(),ADMIN_PASSWORD:'admin-test-secret-123',EXPERT_PASSWORD:'expert-test-secret-123',MODEL_VAULT_KEY:Buffer.alloc(32,7).toString('base64'),MAX_MODEL_CALLS_PER_DAY:'3',ASSETS:{fetch:async()=>new Response('static test')}};
 const client=()=>({cookie:'',csrf:'',
  async send(path,method='GET',body,overrides={}){
   const headers=new Headers({'Origin':origin,'CF-Connecting-IP':'127.0.0.1'});
   if(this.cookie)headers.set('cookie',this.cookie);if(this.csrf)headers.set('x-csrf-token',this.csrf);
   let data=body;if(body&&!(body instanceof FormData)){headers.set('Content-Type','application/json');data=JSON.stringify(body);}
   for(const [key,value]of Object.entries(overrides))value===null?headers.delete(key):headers.set(key,value);
   const response=await worker.fetch(new Request(origin+path,{method,headers,...(data!==undefined?{body:data}:{})}),env,{});
   const text=await response.text();let json;try{json=JSON.parse(text);}catch{json=text;}
   const cookie=response.headers.get('set-cookie');if(cookie)this.cookie=cookie.split(';')[0];if(json.csrf)this.csrf=json.csrf;
   return {status:response.status,data:json,headers:response.headers,text};
  },
  async login(username,password){return this.send('/api/auth/login','POST',{username,password});}
 });
 return {env,client};
}
const form=(work=payload(),version, audio)=>{const data=new FormData();data.set('payload',JSON.stringify(work));if(version!==undefined)data.set('version',String(version));if(audio)data.set('audio',new Blob([audio]),'测试录音.wav');return data;};

test('Worker: auth, CSRF, first password, roles, private CRUD, optimistic versions, audio cleanup',async()=>{
 const {env,client}=harness(),admin=client(),expert=client(),anonymous=client();
 assert.equal((await anonymous.send('/api/works')).status,401);
 assert.equal((await anonymous.send('/api/health')).status,200);
 assert.equal((await admin.login('admin','wrong')).status,401);
 assert.equal((await admin.send('/api/auth/login','POST',{username:'admin',password:env.ADMIN_PASSWORD},{Origin:'https://evil.example'})).status,403);
 const initial=await admin.login('admin',env.ADMIN_PASSWORD);assert.equal(initial.status,200);assert.equal(initial.data.user.mustChange,true);assert.match(initial.headers.get('set-cookie'),/HttpOnly; SameSite=Lax; Max-Age=28800; Secure/);
 assert.equal((await admin.send('/api/admin/users')).status,403);
 const stale=client();stale.cookie=admin.cookie;stale.csrf=admin.csrf;
 const changed=await admin.send('/api/auth/password','POST',{currentPassword:env.ADMIN_PASSWORD,newPassword:'changed-admin-secret-123'});assert.equal(changed.status,200);assert.equal(changed.data.user.mustChange,false);
 assert.equal((await stale.send('/api/auth/me')).status,401);
 const logged=await expert.login('expert01',env.EXPERT_PASSWORD);assert.equal(logged.status,200);assert.equal(logged.data.user.mustChange,false);
 assert.equal((await expert.send('/api/admin/users')).status,403);
 assert.equal((await expert.send('/api/works','POST',form(),{'X-CSRF-Token':null})).status,403);
 assert.equal((await expert.send('/api/works','POST',form(),{Origin:'https://evil.example'})).status,403);
 const created=await expert.send('/api/works','POST',form(payload(),undefined,wav()));assert.equal(created.status,200);const id=created.data.id;assert.equal(created.data.version,1);assert.equal(env.BUCKET.objects.size,1);
 const listed=await expert.send('/api/works');assert.equal(listed.data[0].title,payload().score.title);assert.equal(listed.data[0].engine,'demo');
 const reopened=await expert.send(`/api/works/${id}`);assert.equal(reopened.data.score.title,payload().score.title);assert.equal(reopened.data.audioName,'测试录音.wav');
 const audio=await expert.send(`/api/works/${id}/audio`);assert.equal(audio.status,200);assert.equal(audio.headers.get('content-type'),'audio/wav');
 assert.equal((await admin.send(`/api/works/${id}`)).status,404);assert.equal((await admin.send(`/api/works/${id}/audio`)).status,404);
 assert.equal((await admin.send(`/api/works/${id}`,'PUT',form(payload(),1))).status,404);
 assert.equal((await admin.send(`/api/works/${id}`,'DELETE')).status,404);
 const concurrent=await Promise.all([expert.send(`/api/works/${id}`,'PUT',form(payload(),1)),expert.send(`/api/works/${id}`,'PUT',form(payload(),1))]);assert.deepEqual(concurrent.map(x=>x.status).sort(),[200,409]);
 const bad=payload();bad.score.tempo=999;assert.equal((await expert.send('/api/works','POST',form(bad))).status,400);
 assert.equal((await expert.send('/api/works','POST',form(payload(),undefined,Buffer.alloc(100,65)))).status,400);
 assert.equal((await expert.send('/api/works','POST',form(payload(),undefined,wav({silent:true})))).status,400);
 assert.equal((await expert.send(`/api/works/${id}`,'DELETE')).status,200);assert.equal(env.BUCKET.objects.size,0);assert.equal((await expert.send(`/api/works/${id}`)).status,404);
 const user=await admin.send('/api/admin/users','POST',{username:'teacher02',displayName:'教师'});assert.equal(user.status,200);assert.equal(user.data.user.admin,false);assert.equal(user.data.user.mustChange,true);assert.ok(user.data.initialPassword.length>=12);
 assert.equal((await admin.send('/api/admin/users','POST',{username:'teacher02'})).status,409);
 const target=(await admin.send('/api/admin/users')).data.find(u=>u.username==='expert01');
 assert.equal((await admin.send(`/api/admin/users/${target.id}/disabled`,'POST',{disabled:true})).status,200);assert.equal((await expert.send('/api/auth/me')).status,401);
 assert.equal((await admin.send(`/api/admin/users/${target.id}/disabled`,'POST',{disabled:false})).status,200);
 const reset=await admin.send(`/api/admin/users/${target.id}/reset`,'POST');assert.equal(reset.status,200);assert.equal((await expert.login('expert01',env.EXPERT_PASSWORD)).status,401);assert.equal((await expert.login('expert01',reset.data.initialPassword)).data.user.mustChange,true);
 const me=await expert.send('/api/auth/me');assert.ok(me.data.csrf);assert.equal(me.data.localMode,false);
 const hash=env.DB.db.prepare("SELECT password_hash FROM users WHERE username='admin'").get().password_hash;assert.ok(!hash.includes('changed-admin'));assert.match(hash,/^pbkdf2:100000:/);
 const logout=await expert.send('/api/auth/logout','POST');assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
 assert.equal((await expert.send('/api/auth/me')).status,401);assert.equal((await anonymous.send('/')).data,'static test');
});

test('Worker: one shared encrypted model config, bounded tools, quota, retained key, SSRF rejection',async()=>{
 const {env,client}=harness(),admin=client(),expert=client();await admin.login('admin',env.ADMIN_PASSWORD);await admin.send('/api/auth/password','POST',{currentPassword:env.ADMIN_PASSWORD,newPassword:'changed-admin-secret-123'});await expert.login('expert01',env.EXPERT_PASSWORD);
 let r=await expert.send('/api/agent','POST',{score:demoScore(),instruction:'设置G调'});assert.equal(r.data.modelStatus,'unconfigured');
 const secret='sk-test-shared-runtime-secret-123456';const config={baseUrl:'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',model:'qwen-plus',apiKey:secret};
 assert.equal((await expert.send('/api/admin/model','PUT',config)).status,403);
 assert.equal((await admin.send('/api/admin/model','PUT',{...config,baseUrl:'https://evil.example/compatible-mode/v1'})).status,400);
 assert.equal((await admin.send('/api/admin/model','PUT',{...config,apiKey:'sk-****masked****'})).status,400);
 assert.equal((await admin.send('/api/admin/model','PUT',config)).status,200);
 const stored=env.DB.db.prepare("SELECT value FROM app_settings WHERE key='model_settings'").get().value;assert.ok(!stored.includes(secret));assert.ok(JSON.parse(stored).key.iv);
 r=await admin.send('/api/admin/model');assert.equal(r.data.keySet,true);assert.ok(!r.text.includes(secret));assert.equal(r.data.apiKey,undefined);
 assert.equal((await admin.send('/api/admin/model','PUT',{baseUrl:config.baseUrl,model:'qwen-plus'})).status,200);
 const originalFetch=globalThis.fetch;let calls=0;
 globalThis.fetch=async(url,options)=>{calls++;assert.equal(options.headers.Authorization,'Bearer '+secret);assert.equal(url,config.baseUrl+'/chat/completions');const body=JSON.parse(options.body);assert.ok(!JSON.stringify(body).includes('rawEvents'));return new Response(JSON.stringify({choices:[{message:{content:body.max_tokens===8?'OK':JSON.stringify({steps:[{tool:'set_key',key:'G'},{tool:'set_tempo',tempo:88}],report:'test'})}}],usage:{prompt_tokens:10,completion_tokens:5}}),{headers:{'Content-Type':'application/json'}});};
 try {
  r=await admin.send('/api/admin/model/test','POST');assert.equal(r.data.ok,true);assert.equal(r.data.modelHealth.status,'success');
  const score=demoScore();r=await expert.send('/api/agent','POST',{score,instruction:'G调，速度88'});assert.equal(r.data.modelStatus,'success');assert.equal(r.data.score.key,'G');assert.equal(r.data.score.tempo,88);
  assert.deepEqual(r.data.score.measures.flatMap(m=>m.notes).map(n=>midiOf(n,'G')),score.measures.flatMap(m=>m.notes).map(n=>midiOf(n,'C')));
  r=await expert.send('/api/agent','POST',{score,instruction:' '});assert.equal(r.data.modelStatus,'not_run');assert.equal(calls,2);
  await admin.send('/api/admin/model/test','POST');assert.equal(calls,3);
  r=await expert.send('/api/agent','POST',{score,instruction:'速度88'});assert.equal(r.status,429);assert.equal(calls,3);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS count FROM model_leases').get().count,0);
  r=await expert.send('/api/model/status');assert.equal(r.data.status,'success');assert.ok(!r.text.includes(secret));
 }finally{globalThis.fetch=originalFetch;}
});

test('Worker: WAV container/duration/silence checks and MP3 frame validation',()=>{
 const data=wav();assert.equal(inspectAudio(data).type,'audio/wav');assert.equal(inspectAudio(data).duration,4);
 assert.throws(()=>inspectAudio(wav({seconds:181})),/3 分钟/);assert.throws(()=>inspectAudio(wav({silent:true})),/静音/);
 assert.throws(()=>inspectAudio(data.subarray(0,100)),/有效/);assert.throws(()=>inspectAudio(new Uint8Array(21*1024*1024)),/20 MB/);
 // Two MPEG-1 layer-3 frames: structure-only validation, not decode quality.
 const mp3=new Uint8Array(417*2);mp3.set([255,251,144,0],0);mp3.set([255,251,144,0],417);assert.equal(inspectAudio(mp3).type,'audio/mpeg');assert.throws(()=>inspectAudio(mp3.subarray(0,500)),/有效/);
});

test('Worker: login brute force limit is persisted and does not expose account existence',async()=>{
 const {env,client}=harness(),guest=client();for(let i=0;i<15;i++)assert.equal((await guest.login('missing','bad')).status,401);assert.equal((await guest.login('missing','bad')).status,429);assert.ok(env.DB.db.prepare('SELECT COUNT(*) AS n FROM rate_limits').get().n>0);
});

test('Worker: cleanup removes staged orphans, preserves referenced objects',async()=>{
 const {env,client}=harness(),expert=client();await expert.login('expert01',env.EXPERT_PASSWORD);await expert.send('/api/works','POST',form(payload(),undefined,wav()));
 env.DB.db.prepare('INSERT INTO blobs(key,bytes,created_at) VALUES(?,?,?)').run('orphan',10,Date.now()-7200000);await env.BUCKET.put('orphan',new Uint8Array(10));
 await cleanup(env);assert.equal(env.BUCKET.objects.size,1);assert.equal(env.BUCKET.objects.has('orphan'),false);assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM blobs').get().n,1);
});
