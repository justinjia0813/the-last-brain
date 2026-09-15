// Uses the user's explicitly enabled Obsidian CLI. Only a temporary view and in-memory fixtures are mutated.
// Install this build first, then: node tests/native-ui.cjs
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
function evaluate(code) {
  const output = execFileSync('obsidian', ['vault=workspace', 'eval', `code=(async()=>{${code}})()`], {encoding:'utf8',timeout:15000});
  if (!output.startsWith('=> ')) throw Error(output);
  const json=output.slice(3).trim();
  if (json.startsWith('Error')) throw Error(json);
  return JSON.parse(json);
}
try {
  evaluate(`
    const p=app.plugins.plugins['the-last-brain'];
    if(p.manifest.version!=='0.2.0') throw Error('Install 0.2.0 first');
    const real=app.workspace.getLeavesOfType('the-last-brain-chat')[0].view;
    const leaf=app.workspace.getLeaf('tab');
    const data={version:1,settings:{...p.data.settings,model:'测试模型',baseUrl:'http://localhost:11434/v1',secretName:'test-only',networkConsent:false},conversations:[],memories:[],activeConversationId:null};
    const host={data,busy:false,status:'独立界面测试',error:'',save:async()=>{},refresh:()=>view.refresh(),
      newConversation:async()=>{const id=crypto.randomUUID();data.conversations.unshift({id,title:'测试对话',createdAt:1,updatedAt:1,messages:[]});data.activeConversationId=id;view.refresh()},
      selectConversation:async id=>{data.activeConversationId=id;view.refresh()},deleteConversation:async()=>{},
      send:async text=>{if(!data.activeConversationId)await host.newConversation();const c=data.conversations.find(c=>c.id===data.activeConversationId);c.messages.push({id:crypto.randomUUID(),role:'user',content:text,createdAt:1,sources:[]},{id:crypto.randomUUID(),role:'assistant',content:'测试回答 <img src=x onerror=alert(1)>',createdAt:2,sources:[]});view.refresh()},
      distill:async()=>{data.memories.unshift({id:'qa-memory',conversationId:data.activeConversationId,content:'待审阅内容',sources:[],createdAt:1,status:'draft'});view.refresh()},
      confirmMemory:async id=>{data.memories.find(m=>m.id===id).status='confirmed';view.refresh()},
      updateMemory:async(id,content,confirm)=>{if(host.failSave)throw Error('测试保存失败');Object.assign(data.memories.find(m=>m.id===id),{content,status:confirm?'confirmed':'draft'});view.refresh()},
      deleteMemory:async()=>{},openSource:async()=>{},openSettings:()=>{},openModelSettings:()=>{},stop:()=>{host.busy=false;view.refresh()}};
    const view=new real.constructor(leaf,host);await leaf.open(view);await app.workspace.revealLeaf(leaf);
    window.__tlbQa={host,view,leaf,originalLeaf:real.leaf};
    return JSON.stringify({ok:true});
  `);
  const first=evaluate(`
    const {view,host}=window.__tlbQa;const root=view.containerEl.querySelector('.tlb-view');
    const input=root.querySelector('textarea');input.value='未创建对话的草稿';input.dispatchEvent(new Event('input',{bubbles:true}));
    if(root.querySelector('.tlb-send').disabled)throw Error('Send button must enable on input');
    view.refresh();if(root.querySelector('textarea').value!=='未创建对话的草稿')throw Error('Draft lost');
    root.querySelector('.tlb-send').click();await new Promise(r=>setTimeout(r,50));
    if(host.data.conversations[0].messages.length!==2)throw Error('Send failed');
    if(root.querySelector('.tlb-message-content img'))throw Error('Unsafe output');
    if(root.querySelector('.tlb-retry'))throw Error('Completed answer must not show retry');
    return JSON.stringify({send:true,draft:true,safeText:true});
  `);
  const sizes=[];
  for(const [width,height] of [[320,446],[640,600],[960,420]]) {
    sizes.push(evaluate(`
      const {view}=window.__tlbQa;const root=view.containerEl.querySelector('.tlb-view');root.style.width='${width}px';root.style.height='${height}px';root.style.flex='none';
      await new Promise(r=>setTimeout(r,100));
      const r=root.getBoundingClientRect(), composer=root.querySelector('.tlb-composer-wrap').getBoundingClientRect();
      const input=root.querySelector('textarea');input.value='尺寸草稿';input.dispatchEvent(new Event('input',{bubbles:true}));view.refresh();
      if(root.querySelector('textarea').value!=='尺寸草稿')throw Error('Resize draft lost');
      if(root.scrollWidth>root.clientWidth+1)throw Error('Horizontal overflow');
      if(composer.bottom>r.bottom+1)throw Error('Composer below panel');
      return JSON.stringify({width:${width},height:${height},overflow:root.scrollWidth-root.clientWidth});
    `));
  }
  const themes=evaluate(`
    const {view,host}=window.__tlbQa;const root=view.containerEl.querySelector('.tlb-view');
    const originalTheme=document.body.className;let light,dark;
    try{document.body.classList.remove('theme-dark');document.body.classList.add('theme-light');light=getComputedStyle(root).backgroundColor;
    document.body.classList.remove('theme-light');document.body.classList.add('theme-dark');dark=getComputedStyle(root).backgroundColor;
    }finally{document.body.className=originalTheme;}
    if(light===dark)throw Error('Themes did not adapt');
    host.settingsBackup=host.data.settings.model;host.data.settings.model='very-long-configured-model-name-for-narrow-pane';host.busy=true;view.refresh();
    root.style.width='320px';await new Promise(r=>setTimeout(r,100));
    const actions=root.querySelector('.tlb-composer-actions');if(actions.scrollWidth>actions.clientWidth+1)throw Error('Busy composer overflow');
    if(!root.querySelector('[aria-label="停止后续处理"]'))throw Error('Stop inaccessible');
    host.busy=false;host.data.settings.model=host.settingsBackup;view.refresh();
    return JSON.stringify({light,dark,busyComposer:true});
  `);
  const memory=evaluate(`
    const {view,host}=window.__tlbQa;await host.distill();
    view.containerEl.querySelector('.tlb-memory-nav').click();
    const review=[...view.containerEl.querySelectorAll('button')].find(b=>b.textContent==='审阅与编辑');review.click();
    const editor=document.querySelector('.tlb-memory-editor');editor.value='已编辑的测试记忆';
    host.failSave=true;[...document.querySelectorAll('.modal button')].find(b=>b.textContent==='保存并确认').click();await new Promise(r=>setTimeout(r,50));
    if(!document.querySelector('.tlb-memory-editor'))throw Error('Failed save lost editor');
    host.failSave=false;[...document.querySelectorAll('.modal button')].find(b=>b.textContent==='保存并确认').click();await new Promise(r=>setTimeout(r,50));
    if(host.data.memories[0].content!=='已编辑的测试记忆'||host.data.memories[0].status!=='confirmed')throw Error('Memory save failed');
    return JSON.stringify({edit:true,rollback:true,confirmed:true});
  `);
  console.log(JSON.stringify({passed:true,first,sizes,themes,memory,scope:'temporary native view; in-memory host; no model calls'},null,2));
} finally {
  evaluate(`if(window.__tlbQa){const q=window.__tlbQa;q.leaf.detach();await app.workspace.revealLeaf(q.originalLeaf);delete window.__tlbQa;}return JSON.stringify({cleaned:true});`);
}
