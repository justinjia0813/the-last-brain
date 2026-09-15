// Native Obsidian modal with in-memory settings/secrets and a local synthetic model only.
const {spawn}=require('node:child_process');
const http=require('node:http');
const assert=require('node:assert/strict');
function evaluate(code){return new Promise((resolve,reject)=>{
 const child=spawn('obsidian',['vault=workspace','eval',`code=(async()=>{${code}})()`]);let output='';let done=false;
 const timer=setTimeout(()=>finish(Error('Obsidian CLI response timed out')),10000);
 function finish(error,value){if(done)return;done=true;clearTimeout(timer);child.kill('SIGKILL');if(error)reject(error);else resolve(value)}
 child.on('error',finish);child.stdout.on('data',chunk=>{output+=chunk;if(!output.includes('\n'))return;try{if(!output.startsWith('=> '))throw Error(output);finish(null,JSON.parse(output.slice(3).trim()))}catch(error){finish(error)}});
 child.on('exit',()=>{if(!done)finish(Error(output||'CLI exited without result'))});
});}
const requests=[];
let responseStatus=200;
const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push({headers:req.headers,body:JSON.parse(body)});res.writeHead(responseStatus,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'Synthetic greeting'}}]}));});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const endpoint=`http://127.0.0.1:${server.address().port}/v1`;
 try{
  await evaluate(`
   const p=app.plugins.plugins['the-last-brain'];
   const secrets=new Map([['old-test-secret','old-synthetic-key']]);
   const settings={baseUrl:${JSON.stringify(endpoint)},model:'synthetic-model',secretName:'old-test-secret',excludedFolders:'never-change',maxSources:6,contextChars:16000,networkConsent:false};
   const proxy=new Proxy(app,{get:(target,key)=>key==='secretStorage'?{getSecret:n=>secrets.get(n)||'',setSecret:(n,v)=>secrets.set(n,v)}:Reflect.get(target,key)});
   const fixture={app:proxy,data:{settings},busy:false,refresh:()=>{},save:async()=>{if(fixture.failSave)throw Error('synthetic disk failure')}};
   window.__tlbModelQa={fixture,secrets,open:()=>p.openModelSettings.call(fixture)};window.__tlbModelQa.open();
   return JSON.stringify({ok:true});
  `);
  await evaluate(`
   const modal=document.querySelector('.tlb-model-modal');const provider=modal.querySelector('#tlb-provider');
   provider.value='deepseek';provider.dispatchEvent(new Event('change'));
   const model=modal.querySelector('#tlb-model');model.value='test-model';model.dispatchEvent(new Event('input'));
   [...modal.querySelectorAll('button')].find(b=>b.textContent==='保存并使用').click();await new Promise(r=>setTimeout(r,10));
   if(!modal.querySelector('.tlb-model-message').textContent.includes('云端服务需要密钥'))throw Error('Missing key not blocked');
   provider.value='custom';provider.dispatchEvent(new Event('change'));
   if(model.value!=='synthetic-model')throw Error('Provider draft lost');
   const url=modal.querySelector('#tlb-url');url.value='https://example.invalid/v1/chat/completions///';url.dispatchEvent(new Event('input'));url.dispatchEvent(new Event('blur'));
   if(modal.querySelector('[data-key-state]').textContent.includes('此服务地址已有密钥'))throw Error('Old key crossed endpoint');
   window.__tlbModelQa.fixture.data.settings.networkConsent=true;
   [...modal.querySelectorAll('button')].find(b=>b.textContent==='保存并使用').click();await new Promise(r=>setTimeout(r,10));
   const settings=window.__tlbModelQa.fixture.data.settings;
   if(settings.baseUrl!=='https://example.invalid/v1'||settings.secretName==='old-test-secret'||settings.networkConsent!==true)throw Error('Save isolation failed');
   return JSON.stringify({endpointIsolation:true,providerDraft:true});
  `);
  await evaluate(`
   const q=window.__tlbModelQa;q.open();q.fixture.failSave=true;
   const modal=document.querySelector('.tlb-model-modal');const key=modal.querySelector('#tlb-key');key.value='new-synthetic-key';key.dispatchEvent(new Event('input'));
   [...modal.querySelectorAll('button')].find(b=>b.textContent==='保存并使用').click();await new Promise(r=>setTimeout(r,10));
   if(!modal.isConnected||!modal.querySelector('.tlb-model-message').textContent.includes('保存失败'))throw Error('Save failure lost draft');
   if(q.secrets.get(q.fixture.data.settings.secretName))throw Error('Secret rollback failed');
   [...modal.querySelectorAll('button')].find(b=>b.textContent==='取消').click();q.fixture.failSave=false;
   q.fixture.data.settings.baseUrl=${JSON.stringify(endpoint)};q.open();
   [...document.querySelector('.tlb-model-modal').querySelectorAll('button')].find(b=>b.textContent==='测试连接').click();
   return JSON.stringify({rollback:true});
  `);
  const result=await evaluate(`
   const modal=document.querySelector('.tlb-model-modal');
   for(let i=0;i<100&&!modal.querySelector('.tlb-model-message').textContent.includes('连接成功');i++)await new Promise(r=>setTimeout(r,20));
   const message=modal.querySelector('.tlb-model-message').textContent;
   if(!message.includes('连接成功'))throw Error(message);
   return JSON.stringify({connection:true});
  `);
  assert.equal(requests.length,1);
  assert.equal(requests[0].headers.authorization,undefined);
  assert.equal(requests[0].body.messages.at(-1).content,'Please reply with a brief greeting.');
  assert.doesNotMatch(JSON.stringify(requests),/never-change|old-synthetic-key|new-synthetic-key/);
  responseStatus=401;
  await evaluate(`const modal=document.querySelector('.tlb-model-modal');[...modal.querySelectorAll('button')].find(b=>b.textContent==='测试连接').click();return JSON.stringify({sent:true});`);
  await evaluate(`const modal=document.querySelector('.tlb-model-modal');for(let i=0;i<100&&!modal.querySelector('.tlb-model-message').textContent.includes('鉴权失败');i++)await new Promise(r=>setTimeout(r,20));if(!modal.querySelector('.tlb-model-message').textContent.includes('鉴权失败'))throw Error('Missing auth guidance');return JSON.stringify({authError:true});`);
  console.log(JSON.stringify({passed:true,...result,requests:requests.length,endpointIsolation:true,providerDraft:true,saveRollback:true,secretRollback:true,scope:'temporary settings and secret storage; local synthetic endpoint'},null,2));
 }finally{
  await evaluate(`const m=document.querySelector('.tlb-model-modal');if(m)[...m.querySelectorAll('button')].find(b=>b.textContent==='取消')?.click();delete window.__tlbModelQa;return JSON.stringify({cleaned:true});`);
  server.close();
 }
})().catch(e=>{console.error(e);server.close();process.exitCode=1});
