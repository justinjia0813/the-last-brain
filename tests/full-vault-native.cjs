// Read-only integration check against the installed plugin; no model request or data persistence.
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const manifest=require('../manifest.json');
const code=`(async()=>{
 const p=app.plugins.plugins['the-last-brain'];if(p.busy)throw Error('Wait for the active request');
 if(p.manifest.version!==${JSON.stringify(manifest.version)})throw Error('Install current release first');
 const oldStatus=p.status;const files=app.vault.getMarkdownFiles().sort((a,b)=>a.path.localeCompare(b.path));
 const excluded=p.data.settings.excludedFolders.split(/[\\n,;]/).map(x=>x.trim().replace(/\\\\/g,'/').replace(/^\\/+|\\/+$/g,'')).filter(Boolean);
 const allowed=files.filter(f=>!excluded.some(d=>f.path===d||f.path.startsWith(d+'/')));
 const previouslySkipped=new Set();let bytes=0;for(const f of allowed){if(f.stat.size>1000000||bytes+f.stat.size>20000000){previouslySkipped.add(f.path);continue}bytes+=f.stat.size}
 try{const start=performance.now();const r=await p.readSources('硫化物');
 if(r.scanned+r.failed!==allowed.length)throw Error('Incomplete coverage');
 let recovered=r.sources.filter(s=>previouslySkipped.has(s.path)).length;
 for(const file of allowed.filter(f=>previouslySkipped.has(f.path)&&f.stat.size>200).slice(-3).reverse()){
  if(recovered)break;
  const text=await app.vault.cachedRead(file);
  const line=text.split('\\n').map(x=>x.trim()).find(x=>x.length>=30&&!/^[#|!>]/.test(x));
  if(!line)continue;
  const targeted=await p.readSources(line.slice(0,100));
  recovered=targeted.sources.filter(s=>previouslySkipped.has(s.path)).length;
 }
 return JSON.stringify({version:p.manifest.version,total:files.length,scanned:r.scanned,excluded:r.excluded,failed:r.failed,sourceCount:r.sources.length,sourcesBeyondOldLimit:recovered,oldSkipped:previouslySkipped.size,elapsedMs:Math.round(performance.now()-start),modelRequests:0});
 }finally{p.status=oldStatus;p.refresh()}
})()`;
const child=spawn('obsidian',['vault=workspace','eval',`code=${code}`]);let output='',done=false;
const timer=setTimeout(()=>{child.kill('SIGKILL');console.error('Read-only verification timed out');process.exitCode=1},60000);
child.stdout.on('data',b=>{if(done)return;output+=b;if(!output.includes('\n'))return;try{const value=JSON.parse(output.replace(/^=> /,''));done=true;clearTimeout(timer);child.kill('SIGKILL');fs.mkdirSync('output/release-0.2.1',{recursive:true});fs.writeFileSync('output/release-0.2.1/full-vault-check.json',JSON.stringify(value,null,2));console.log(JSON.stringify(value,null,2))}catch{done=true;clearTimeout(timer);child.kill('SIGKILL');console.error(output);process.exitCode=1}});
