const assert=require('node:assert/strict'),http=require('http'),fs=require('fs');
const {chromium}=require('playwright-core');
const {SubflowSession,SubflowScheduler}=require('../src/subflows');
const {Runner,config,sleep}=require('../src/engine');
const {crop}=require('../src/vision');
const html=`<html><body><div id="ready" style="width:120px;height:60px;background:#27a488">READY</div><div id="health" style="width:100px;height:30px;background:#ff66bb">HEALTH</div><button id="before" onclick="window.beforeCount=(window.beforeCount||0)+1">Before</button><input id="value"><button id="add" onclick="window.count=(window.count||0)+1">Add</button><button id="popup" onclick="window.open('/popup')">Popup</button><script>if(location.search.includes("blocked"))document.querySelector("#ready").style.visibility="hidden";</script></body></html>`;
async function until(fn,ms=20000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(50);}throw Error('Timed out');}
async function fixture(){
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+server.address().port;
  const b=await chromium.launch({channel:'chrome',headless:true});let trusted,health;
  try{const p=await b.newPage({viewport:{width:1280,height:720}});await p.goto(url);const result=crop(await p.screenshot(),{x:8,y:8,width:120,height:60});trusted={rect:result.rect,image:result.buffer.toString('base64'),page:0};const h=crop(await p.screenshot(),await p.locator('#health').boundingBox());health={rect:h.rect,image:h.buffer.toString('base64'),page:0};}finally{await b.close();}
  const flow={version:1,id:'11111111-1111-4111-8111-111111111111',name:'子流程验收',viewport:{width:1280,height:720},config:config({grace:0,interval:1,actionInterval:20,retries:1,checkpointTimeout:5000,stepTimeout:5000}),steps:[{type:'goto',url,page:0}],trusted};
  return {flow,health,close:()=>new Promise(r=>server.close(r))};
}
async function main(){
 const site=await fixture();let session,run;
 try{
  session=new SubflowSession(site.flow);await session.start();assert.equal(session.phase,'condition');assert.equal(session.recorder.flow.steps.length,0);
  const browser=session.recorder.browser,p=session.recorder.pages.get(0);
  // Legacy timeout is ignored only inside subflow checkpoints.
  const gate={type:'checkpoint',trusted:site.flow.trusted,timeout:1000,threshold:.9};
  const gated={id:'gate',name:'无限等待验收',trigger:{type:'cron',expression:'* * * * * *'},steps:[gate,{type:'click',selector:'#add'}]};
  await p.locator('#ready').evaluate(el=>el.style.visibility='hidden');
  const controller=new AbortController(),gateLogs=[],pages=new Map([[0,p]]);
  const scheduler=new SubflowScheduler([gated,{id:'other',name:'其他截图子流程',trigger:{type:'cron',expression:'* * * * *'},steps:[{type:'fill',selector:'#value',value:'other ran'}]}]);
  await scheduler.tick(pages,site.flow.config,controller.signal,(l,m)=>gateLogs.push(m));
  assert.equal(await p.locator('#value').inputValue(),'other ran');
  await sleep(1700);await scheduler.tick(pages,site.flow.config,controller.signal,()=>{});
  assert.equal(await p.evaluate(()=>window.count||0),0);assert.ok(!gateLogs.some(m=>m.includes('失败')));
  await p.locator('#ready').evaluate(el=>el.style.visibility='visible');
  await scheduler.tick(pages,site.flow.config,controller.signal,()=>{});assert.equal(await p.evaluate(()=>window.count),1);
  await p.locator('#ready').evaluate(el=>el.style.visibility='hidden');
  const cancel=new AbortController(),cancelScheduler=new SubflowScheduler([gated]);
  await cancelScheduler.tick(pages,site.flow.config,cancel.signal,()=>{});cancel.abort();
  await assert.rejects(cancelScheduler.tick(pages,site.flow.config,cancel.signal,()=>{}));
  await cancelScheduler.reset(pages);assert.equal(cancelScheduler.executions.size,0);assert.equal(await p.evaluate(()=>window.count),1);
  await assert.rejects(()=>require('../src/engine').waitForCheckpoint(p,gate,site.flow.config,new AbortController().signal),{code:'CHECKPOINT_TIMEOUT'});
  await p.locator('#ready').evaluate(el=>el.style.visibility='visible');
  // Retain popup ownership across a suspended checkpoint, then close on completion/reset.
  const popupSub={id:'popup-wait',name:'弹出页等待',pageBase:1,trigger:{type:'cron',expression:'* * * * *'},steps:[{type:'click',selector:'#popup'},gate,{type:'click',selector:'#add',page:1}]};
  const popupScheduler=new SubflowScheduler([popupSub]);
  await p.locator('#ready').evaluate(el=>el.style.visibility='hidden');
  await popupScheduler.tick(pages,site.flow.config,new AbortController().signal,()=>{});
  const held=popupScheduler.executions.get(popupSub.id);assert.equal(held.index,1);assert.equal(held.created.length,1);assert.equal(held.created[0].isClosed(),false);
  await p.locator('#ready').evaluate(el=>el.style.visibility='visible');
  await popupScheduler.tick(pages,site.flow.config,new AbortController().signal,()=>{});
  assert.equal(held.created[0].isClosed(),true);assert.equal(popupScheduler.executions.size,0);
  const resetScheduler=new SubflowScheduler([popupSub]);await p.locator('#ready').evaluate(el=>el.style.visibility='hidden');
  await resetScheduler.tick(pages,site.flow.config,new AbortController().signal,()=>{});
  const resetPopup=resetScheduler.executions.get(popupSub.id).created[0];await resetScheduler.reset(pages);
  assert.equal(resetPopup.isClosed(),true);assert.equal(resetScheduler.executions.size,0);
  await p.locator('#ready').evaluate(el=>el.style.visibility='visible');
  await p.locator('#value').fill('not-recorded');await sleep(200);assert.equal(session.recorder.flow.steps.length,0);
  await assert.rejects(()=>session.setTrigger({type:'cron',expression:'invalid'}));
  await session.setTrigger({type:'cron',expression:'* * * * *'});await session.finish();assert.throws(()=>session.save('empty'),/至少/);
  await session.recorder.resumeCapture();session.setPhase('recording');
  await p.locator('#value').fill('private-value');await p.locator('#add').click();await session.finish();session.save('定时填写');
  assert.ok(session.flow.subflows[0].steps.some(s=>s.type==='fill'&&s.value==='private-value'));
  const saved=structuredClone(session.flow.subflows[0]),context=session.recorder.context,pageBase=session.pageBase;
  await p.evaluate(()=>{window.keepScreen='preserved';sessionStorage.setItem('keep','yes');});
  await p.locator('#value').fill('manual-before-next');
  await session.next();assert.equal(session.recorder.browser,browser);assert.equal(session.recorder.context,context);
  assert.equal(session.recorder.pages.get(0),p);assert.equal(p.isClosed(),false);assert.equal(session.pageBase,pageBase);
  assert.equal(await p.locator('#value').inputValue(),'manual-before-next');assert.equal(await p.evaluate(()=>window.keepScreen),'preserved');
  assert.equal(await p.evaluate(()=>sessionStorage.getItem('keep')),'yes');assert.equal(session.trigger,null);
  await p.goto(site.flow.steps[0].url+'?manual=1');await p.locator('#value').fill('manual-after-next');
  await sleep(200);assert.equal(session.recorder.flow.steps.length,0);assert.deepEqual(session.flow.subflows[0],saved);
  await session.recorder.snapshot();await session.setTrigger({type:'image',rect:site.flow.trusted.rect});
  await session.recorder.pages.get(0).locator('#add').click();await session.finish();session.save('截图点击');assert.equal(session.flow.subflows[1].steps.length,1);assert.equal(session.flow.subflows[1].steps[0].type,'click');
  await session.next();await session.setTrigger({type:'cron',expression:'* * * * *'});
  const root=session.recorder.pages.get(0),popupPromise=root.waitForEvent('popup');await root.locator('#popup').click();const popup=await popupPromise;await popup.waitForLoadState();await popup.locator('#add').click();
  await session.finish();session.save('弹出页动作');
  await session.next();assert.equal(popup.isClosed(),false);
  await session.setTrigger({type:'cron',expression:'* * * * *'});
  const nextPopupPromise=root.waitForEvent('popup');await root.locator('#popup').click();const nextPopup=await nextPopupPromise;
  await nextPopup.waitForLoadState();await nextPopup.goto(site.flow.steps[0].url+'/popup-again');await nextPopup.locator('#add').click();await session.finish();session.save('再次弹出页动作');
  assert.equal(session.flow.subflows[3].steps.at(-1).page,session.pageBase);
  const healthCrop=crop(await p.screenshot(),{x:8,y:68,width:100,height:30});
  const health={page:0,rect:healthCrop.rect,image:healthCrop.buffer.toString('base64')};
  const flow=structuredClone(session.flow);assert.equal(flow.subflows.length,4);await session.stop();
  const nonblocking=structuredClone(site.flow);nonblocking.trusted=site.health;nonblocking.steps[0].url+='?blocked';
  nonblocking.subflows=[{...gated,steps:[{type:'click',selector:'#before'},gate,{type:'click',selector:'#add'}]},
    {id:'healthy',name:'后续图片触发',trigger:{type:'image',trusted:site.health},steps:[{type:'fill',selector:'#value',value:'still running'}]}];
  run=new Runner(nonblocking,config({...site.flow.config,count:2,interval:1,retries:0}));const fairLogs=[];run.on('log',(l,m)=>fairLogs.push(m));run.start();
  try{await until(()=>fairLogs.filter(m=>m.includes('可信图像匹配')).length>=6);}catch(e){console.error(fairLogs.join('\n'));throw e;}
  const fairPages=[...run.browsers].map(b=>b.contexts()[0].pages()[0]);assert.equal(fairPages.length,2);
  for(const fp of fairPages){assert.equal(await fp.evaluate(()=>window.count||0),0);assert.equal(await fp.evaluate(()=>window.beforeCount),1);assert.equal(await fp.locator('#value').inputValue(),'still running');}
  assert.ok(fairLogs.filter(m=>m.includes('子流程完成：后续图片触发')).length>=4);
  await fairPages[0].locator('#ready').evaluate(el=>el.style.visibility='visible');
  await until(async()=>await fairPages[0].evaluate(()=>window.count||0)>0);
  assert.equal(await fairPages[1].evaluate(()=>window.count||0),0);assert.equal(await fairPages[1].evaluate(()=>window.beforeCount),1);
  const stoppedAt=performance.now();await run.stop();assert.ok(performance.now()-stoppedAt<3000);
  run=new Runner(flow,config({...flow.config,count:2,interval:15}));const logs=[];run.on('log',(l,m)=>logs.push(m));run.start();
  await until(()=>logs.filter(x=>x.includes('子流程完成：截图点击')).length>=2);
  await until(()=>logs.filter(x=>x.includes('子流程完成：截图点击')).length>=6,5000);
  assert.equal(logs.filter(x=>x.includes('可信图像匹配')).length,2,'fast subflow polling must not increase inspection frequency');
  assert.equal(logs.filter(x=>x.includes('触发子流程：定时填写')).length,2);
  assert.equal(logs.filter(x=>x.includes('子流程完成：弹出页动作')).length,2);
  assert.equal(logs.filter(x=>x.includes('子流程完成：再次弹出页动作')).length,2);
  assert.ok(!logs.join('\n').includes('private-value'));
  for(const b of run.browsers)assert.equal(await b.contexts()[0].pages()[0].locator('#value').inputValue(),'private-value');
  await run.stop();
  // Inspections still recur on their own deadline while image subflows keep running.
  run=new Runner({...flow,subflows:[flow.subflows[1]]},config({...flow.config,interval:1}));
  const inspections=[],completed=[];run.on('log',(l,m)=>{
    if(m.includes('可信图像匹配'))inspections.push(performance.now());
    if(m.includes('子流程完成：截图点击'))completed.push(performance.now());
  });run.start();
  await until(()=>inspections.length>=3);
  assert.ok(inspections.slice(1).every((t,i)=>t-inspections[i]>=990));
  assert.ok(completed.length>inspections.length);
  assert.ok(completed.slice(1).every((t,i)=>t-completed[i]>=190),'polls rest for 200ms after completion');
  const stopping=performance.now();await run.stop();assert.ok(performance.now()-stopping<3000);
  const seconds=structuredClone(site.flow);seconds.subflows=[{id:'seconds',name:'秒级点击',trigger:{type:'cron',expression:'* * * * * *'},steps:[{type:'click',selector:'#add',page:0}]}];
  run=new Runner(seconds,config({...seconds.config,count:2,interval:15}));
  const secondRuns=new Map();run.on('log',(l,m)=>{if(m.includes('子流程完成：秒级点击'))secondRuns.set(m,(secondRuns.get(m)||0)+1);});
  run.start();await until(()=>secondRuns.size===2&&[...secondRuns.values()].every(n=>n>=3),12000);
  await run.stop();
  const broken=structuredClone(site.flow);broken.subflows=[{id:'retry',name:'失败定时动作',trigger:{type:'cron',expression:'* * * * *'},steps:[{type:'click',selector:'#missing'}]}];
  run=new Runner(broken,broken.config);const failed=[];run.on('log',(l,m)=>failed.push(m));await run.start();
  assert.equal(failed.filter(m=>m.includes('触发子流程：失败定时动作')).length,2,failed.join('\n'));assert.equal(run.states[0].status,'需要人工处理');
  // Retry exhaustion and cancellation never enable recording.
  const bad=structuredClone(site.flow);bad.steps.push({type:'click',selector:'#missing',page:0});
  session=new SubflowSession(bad);let attempts=0;session.on('log',(l,m)=>{if(m.includes('正在恢复主流程'))attempts++;});
  await assert.rejects(()=>session.start(),/上限/);assert.equal(attempts,2);assert.notEqual(session.phase,'recording');await session.stop();
  session=new SubflowSession(bad);const pending=assert.rejects(session.start());await until(()=>!!session.recorder?.context);await session.stop();await pending;
  // Closing Chrome ends the session.
  session=new SubflowSession(site.flow);await session.start();await session.recorder.browser.close();await until(()=>session.phase==='closed');
  fs.writeFileSync('test-results/subflows-e2e-report.txt','PASS: blocked checkpoint yields to later subflow and final inspection in two instances; prefix runs once and independent resume; unlimited subflow checkpoint exceeds legacy timeout without click; match resumes; cancellation blocks click; main checkpoint still times out; restore and suppression; required trigger/action; named save; same Chrome/context/page retained; manual navigation and input excluded; saved draft unchanged; image and cron; two isolated instances; independent 200ms polling with 15s inspections; inspection cadence; no busy polling; minute deduplication; retry exhaustion; stop; browser close; redacted logs.\n');
  console.log('PASS subflows e2e');
 }finally{await run?.stop();await session?.stop();await site.close();}
}
module.exports={fixture,until};if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
